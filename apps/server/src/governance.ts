import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  actionDigest,
  canonicalize,
  freshEntity,
  type Approval,
  type Decision,
  type Session,
} from "../../../packages/domain/src/index.js";
import { Store } from "../../../packages/store/src/index.js";
import { AppError, requireCondition } from "./security.js";

export interface ApprovalMember {
  approvalId: string;
  actionDigest: string;
  expectedRevision: number;
}
export interface ApprovalOutcome {
  approvalId: string;
  ok: boolean;
  state: string;
  error?: string;
}
export interface PendingBinding {
  key: string;
  sessionId: string;
  command: string;
  cwd: string;
  monotonicDeadline: number;
}
export class Governance {
  readonly #keys = generateKeyPairSync("ed25519");
  readonly keyId = randomUUID();
  readonly verificationKey = this.#keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  readonly pending = new Map<string, PendingBinding>();
  constructor(
    readonly store: Store,
    readonly bootId: string,
    readonly dispatch: (
      sessionId: string,
      key: string,
      digest: string,
      decision: "approve" | "deny",
    ) => Promise<void>,
    readonly now: () => number = Date.now,
    readonly monotonic: () => number = () => performance.now(),
    readonly validateContext?: (approval: Approval) => Promise<void>,
  ) {}
  addPending(
    approvalId: string,
    binding: Omit<PendingBinding, "monotonicDeadline">,
    ttlMs = 10 * 60_000,
  ): void {
    requireCondition(
      !this.pending.has(approvalId),
      "duplicate_binding",
      "This action already has a pending binding.",
      409,
    );
    this.pending.set(approvalId, {
      ...binding,
      monotonicDeadline: this.monotonic() + ttlMs,
    });
  }
  verificationBytes(decision: Omit<Decision, "signature"> | Decision): string {
    const {
      signature: _signature,
      delivery: _delivery,
      revision: _revision,
      updatedAt: _updatedAt,
      ...bound
    } = decision as Decision;
    return canonicalize(bound);
  }
  verifyDecision(decision: Decision): boolean {
    return (
      decision.bootId === this.bootId &&
      decision.keyId === this.keyId &&
      this.now() <= Date.parse(decision.expiresAt) &&
      verify(
        null,
        Buffer.from(this.verificationBytes(decision)),
        this.#keys.publicKey,
        Buffer.from(decision.signature, "base64"),
      )
    );
  }
  async resolve(
    projectId: string,
    members: ApprovalMember[],
    decisionType: "approve" | "deny",
  ): Promise<ApprovalOutcome[]> {
    requireCondition(
      members.length > 0 && members.length <= 50,
      "invalid_group",
      "Select between one and fifty pending actions.",
    );
    requireCondition(
      new Set(members.map((m) => m.approvalId)).size === members.length,
      "duplicate_members",
      "An approval may appear only once in a group.",
    );
    requireCondition(
      this.store.verifyAudit().valid,
      "audit_invalid",
      "Governance integrity verification failed; no action will be authorized.",
      409,
    );
    // The caller's frozen IDs/digests/revisions are the whole gesture; never query more members here.
    const outcomes: ApprovalOutcome[] = [];
    for (const member of members) {
      let approval: Approval | undefined;
      let recorded: Decision | undefined;
      try {
        const binding = this.pending.get(member.approvalId);
        const scopedApproval = this.store.get<Approval>(
          "approvals",
          member.approvalId,
        );
        requireCondition(
          scopedApproval && scopedApproval.projectId === projectId,
          "approval_not_found",
          "This approval does not belong to the project.",
          404,
        );
        if (this.validateContext) await this.validateContext(scopedApproval);
        this.store.transaction(() => {
          approval = this.store.get<Approval>("approvals", member.approvalId);
          requireCondition(
            approval && approval.projectId === projectId,
            "approval_not_found",
            "This approval does not belong to the project.",
            404,
          );
          requireCondition(
            approval.state === "pending",
            "already_resolved",
            "This approval is no longer pending.",
            409,
          );
          requireCondition(
            approval.bootId === this.bootId &&
              binding &&
              binding.sessionId === approval.sessionId,
            "disconnected",
            "The original pending session is unavailable.",
            409,
          );
          requireCondition(
            member.expectedRevision === approval.revision &&
              member.actionDigest === approval.actionDigest,
            "stale_action",
            "The reviewed action or revision changed.",
            409,
          );
          requireCondition(
            actionDigest({
              kind: "command",
              command: binding.command,
              cwd: binding.cwd,
            }) === approval.actionDigest,
            "binding_mismatch",
            "The original live command binding no longer matches this action.",
            409,
          );
          const session = this.store.get<Session>(
            "sessions",
            approval.sessionId,
          );
          requireCondition(
            session &&
              session.projectId === projectId &&
              session.taskId === approval.taskId &&
              session.bootId === this.bootId &&
              session.state === "waiting_approval",
            "session_not_waiting",
            "The original session is not waiting for this approval.",
            409,
          );
          requireCondition(
            approval.policySnapshotId === "human-only-v1",
            "policy_changed",
            "The approval policy must be re-evaluated.",
            409,
          );
          requireCondition(
            this.now() < Date.parse(approval.expiresAt) &&
              this.monotonic() < binding.monotonicDeadline,
            "expired",
            "This approval has expired.",
            409,
          );
          const unsigned: Omit<Decision, "signature"> = {
            ...freshEntity("dec"),
            projectId,
            approvalId: approval.id,
            sessionId: approval.sessionId,
            actionDigest: approval.actionDigest,
            decision: decisionType,
            resolver: "human",
            policySnapshotId: approval.policySnapshotId,
            bootId: this.bootId,
            issuedAt: new Date(this.now()).toISOString(),
            expiresAt: approval.expiresAt,
            keyId: this.keyId,
            verificationKey: this.verificationKey,
            delivery: "intent",
          };
          const signed: Decision = {
            ...unsigned,
            signature: sign(
              null,
              Buffer.from(this.verificationBytes(unsigned)),
              this.#keys.privateKey,
            ).toString("base64"),
          };
          requireCondition(
            this.verifyDecision(signed),
            "invalid_signature",
            "The authorization envelope could not be verified.",
            409,
          );
          recorded = this.store.create<Decision>("decisions", signed, "human");
          approval = this.store.update<Approval>(
            "approvals",
            approval.id,
            approval.revision,
            {
              state: decisionType === "approve" ? "approved" : "denied",
              reason: "Human decision recorded; native delivery pending.",
            },
            "human",
          );
        });
        // Consume before native IO. An ambiguous dispatch is never retried or rebound.
        this.pending.delete(member.approvalId);
        requireCondition(
          recorded && approval && binding,
          "binding_missing",
          "The original action binding is missing.",
          409,
        );
        await this.dispatch(
          approval.sessionId,
          binding.key,
          approval.actionDigest,
          decisionType,
        );
        this.store.update<Decision>(
          "decisions",
          recorded.id,
          recorded.revision,
          { delivery: "sent" },
          "bridge",
        );
        const current = this.store.get<Approval>("approvals", approval.id)!;
        this.store.update<Approval>(
          "approvals",
          current.id,
          current.revision,
          {
            reason:
              "Native one-action response sent. Inspect session activity for the execution outcome.",
          },
          "bridge",
        );
        outcomes.push({
          approvalId: member.approvalId,
          ok: true,
          state: approval.state,
        });
      } catch (error) {
        if (recorded && approval) {
          const decision = this.store.get<Decision>("decisions", recorded.id);
          if (decision?.delivery === "intent")
            this.store.update<Decision>(
              "decisions",
              decision.id,
              decision.revision,
              { delivery: "uncertain" },
              "bridge",
            );
          const current = this.store.get<Approval>("approvals", approval.id);
          if (
            current &&
            (current.state === "approved" || current.state === "denied")
          )
            this.store.update<Approval>(
              "approvals",
              current.id,
              current.revision,
              {
                state: "uncertain",
                reason:
                  "Native delivery is uncertain. This decision will not be replayed.",
              },
              "bridge",
            );
        }
        outcomes.push({
          approvalId: member.approvalId,
          ok: false,
          state:
            (this.store.get<Approval>("approvals", member.approvalId)
              ?.projectId === projectId
              ? this.store.get<Approval>("approvals", member.approvalId)?.state
              : "unavailable") ?? "unavailable",
          error:
            error instanceof AppError
              ? error.message
              : "The action could not be safely delivered.",
        });
      }
    }
    return outcomes;
  }
  invalidateSession(sessionId: string): void {
    for (const [id, binding] of this.pending) {
      if (binding.sessionId !== sessionId) continue;
      this.pending.delete(id);
      const approval = this.store.get<Approval>("approvals", id);
      if (approval?.state === "pending")
        this.store.update<Approval>("approvals", id, approval.revision, {
          state: "disconnected",
          reason:
            "Original session disconnected; old decisions cannot be replayed.",
        });
    }
  }
  async expire(): Promise<void> {
    for (const [id, binding] of this.pending) {
      const approval = this.store.get<Approval>("approvals", id);
      if (!approval || approval.state !== "pending") {
        this.pending.delete(id);
        continue;
      }
      if (
        this.now() < Date.parse(approval.expiresAt) &&
        this.monotonic() < binding.monotonicDeadline
      )
        continue;
      this.pending.delete(id);
      this.store.update<Approval>("approvals", id, approval.revision, {
        state: "expired",
        reason: "Approval deadline passed; a late decision cannot resume it.",
      });
      try {
        await this.dispatch(
          binding.sessionId,
          binding.key,
          approval.actionDigest,
          "deny",
        );
      } catch {
        /* Expiry never grants authority; process reconciliation records any loss. */
      }
    }
  }
}
