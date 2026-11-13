import { z } from 'zod';
const owner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine(value => !['.', '..'].includes(value));
export const repositoryName = z.string().refine(value => { const parts = value.split('/'); return parts.length === 2 && owner.safeParse(parts[0]).success && name.safeParse(parts[1]).success; }, 'Use owner/repository.');
export const proposalInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repository.create'), owner, name, visibility: z.enum(['public', 'private']) }).strict(),
  z.object({ kind: z.literal('issue.create'), repository: repositoryName, title: z.string().trim().min(1).max(256), body: z.string().max(30_000), labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]) }).strict(),
]);
export type ProposalInput = z.infer<typeof proposalInput>;
export interface GitHubProfile {
  connected: boolean; connectionId: string | null; identity: { login: string; id: number } | null;
  capabilities: { read: boolean; repositoryCreate: boolean; issueCreate: boolean; administration: boolean; release: boolean };
  status: 'connected' | 'disconnected'; reason?: string; owners: Array<{ login: string; id: number }>; credentialProvider: 'gh-cli';
}
