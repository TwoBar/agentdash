/** Adapter-private recovery metadata. Never stores transcript text, prompts, tokens or callbacks. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
export interface SessionScope { projectId: string; taskId: string }
export interface NativeBinding {
  format: 1;
  ref: string;
  nativeVersion: string;
  nativeThreadId: string;
  currentSessionId: string;
  scope: SessionScope | null;
  cwd: string;
  ownerPid: number;
  ownerGeneration: string;
  stopped: boolean;
  sourceAliases: Array<[string, string]>;
  turnAliases: Array<[string, string]>;
  turnOwners: Array<[string, string]>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const identity = /^[A-Za-z0-9_-]{1,200}$/;
const validIdentity = (value: unknown): value is string => typeof value === 'string' && identity.test(value);
function check(value: unknown): asserts value is NativeBinding {
  const record = value as NativeBinding;
  if (!record || record.format !== 1 || !uuid.test(record.ref) || typeof record.nativeVersion !== 'string' || !validIdentity(record.nativeThreadId) || !validIdentity(record.currentSessionId) || !isAbsolute(record.cwd) || record.cwd.length > 4096 || !uuid.test(record.ownerGeneration) || !Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1 || typeof record.stopped !== 'boolean' || record.scope !== null && (!validIdentity(record.scope?.projectId) || !validIdentity(record.scope?.taskId))) throw new Error('Native recovery metadata is invalid; start a fresh registered session.');
  const keys = new Set(['format','ref','nativeVersion','nativeThreadId','currentSessionId','scope','cwd','ownerPid','ownerGeneration','stopped','sourceAliases','turnAliases','turnOwners']);
  if (Object.keys(record).some(key => !keys.has(key)) || record.scope && Object.keys(record.scope).some(key => !['projectId','taskId'].includes(key))) throw new Error('Native recovery metadata contains unsupported fields.');
  for (const entries of [record.sourceAliases, record.turnAliases, record.turnOwners]) {
    if (!Array.isArray(entries) || entries.length > 25000 || entries.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] || pair[0].length > 1024 || typeof pair[1] !== 'string' || !identity.test(pair[1]))) throw new Error('Native recovery identity map is invalid.');
    if (new Set(entries.map(pair => pair[0])).size !== entries.length) throw new Error('Native recovery identities are duplicated.');
  }
}
const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class BindingStore {
  private readonly directory: string | null;
  constructor(directory?: string) {
    if (!directory) { this.directory = null; return; }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Native recovery storage must be a private owned directory.');
    this.directory = realpathSync(directory);
  }
  get available(): boolean { return !!this.directory; }
  load(ref: string): NativeBinding {
    if (!this.directory || !uuid.test(ref)) throw new Error('No verified native recovery binding is available; start a fresh registered session.');
    try {
      const path = join(this.directory, `${ref}.json`); const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 8 * 1024 * 1024 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Invalid recovery file.');
      const envelope = JSON.parse(readFileSync(path, 'utf8'));
      if (envelope.checksum !== checksum(envelope.binding)) throw new Error('Recovery metadata checksum mismatch.');
      check(envelope.binding);
      if (envelope.binding.ref !== ref) throw new Error('Recovery binding mismatch.');
      return envelope.binding;
    } catch { throw new Error('Native recovery metadata is missing or cannot be verified; start a fresh registered session.'); }
  }
  save(binding: NativeBinding, previousGeneration?: string): void {
    if (!this.directory) return;
    check(binding);
    const path = join(this.directory, `${binding.ref}.json`);
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Native recovery path is not trusted.');
      const existing = this.load(binding.ref);
      if (existing.ownerGeneration !== (previousGeneration ?? binding.ownerGeneration)) throw new Error('Native recovery ownership already changed.');
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = path + '.' + randomUUID() + '.tmp'; const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ binding, checksum: checksum(binding) })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const parent = openSync(this.directory, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  assertStopped(binding: NativeBinding): void {
    if (binding.stopped) return;
    try { process.kill(binding.ownerPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
    throw new Error('The former native process is still running or its ownership is uncertain. Stop its original service before resuming.');
  }
}
