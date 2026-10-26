import type { DomainEvent } from "./domain-event-repository.js";
import type { EventDelivery, EventSubscription } from "./domain-event-delivery-repository.js";
import type { ParsedWorkflow } from "./types.js";

export type DomainEventInvocationRequest = {
  teamId: string;
  workflowId: string;
  revision: number;
  inputs: Record<string, unknown>;
  context: {
    eventId: string;
    deliveryId: string;
    correlationId: string | null;
    causationId: string | null;
  };
  source: {
    eventId: string;
    deliveryId: string;
    correlationId: string | null;
    causationId: string | null;
  };
  idempotencyKey: string;
};

export type DomainEventDispatcherDependencies = {
  events: {
    getForTeam(teamId: string, eventId: string): Promise<DomainEvent | null>;
  };
  deliveries: {
    finish(
      teamId: string,
      deliveryId: string,
      expectedAttemptCount: number,
      result: {
        status: "admitted" | "filtered" | "failed" | "pending";
        jobIds?: string[];
        invocationId?: string;
        error?: string | null;
      },
    ): Promise<unknown>;
  };
  subscriptions: {
    getForTeam(teamId: string, subscriptionId: string): Promise<EventSubscription | null>;
  };
  resolveWorkflow(teamId: string, workflowId: string, revision: number): Promise<ParsedWorkflow | null>;
  admitInvocation(input: DomainEventInvocationRequest): Promise<{ eventId: string; invocationId: string }>;
  /** Optional event filter; false marks this delivery as intentionally filtered. */
  matches?(event: DomainEvent, subscription: EventSubscription, workflow: ParsedWorkflow): Promise<boolean> | boolean;
};

export class DomainEventDispatcher {
  constructor(private readonly dependencies: DomainEventDispatcherDependencies) {}

  async process(delivery: EventDelivery): Promise<void> {
    const { events, deliveries } = this.dependencies;
    const finish = (result: Parameters<typeof deliveries.finish>[3]) =>
      deliveries.finish(delivery.teamId, delivery.id, delivery.attemptCount, result);
    try {
      const event = await events.getForTeam(delivery.teamId, delivery.eventId);
      if (!event) {
        await finish({
          status: "failed",
          error: "Domain event not found for team",
        });
        return;
      }
      const subscription = await this.dependencies.subscriptions.getForTeam(delivery.teamId, delivery.subscriptionId);
      if (!subscription || subscription.teamId !== delivery.teamId) {
        await finish({
          status: "failed",
          error: "Event subscription not found for team",
        });
        return;
      }
      const workflow = await this.dependencies.resolveWorkflow(
        delivery.teamId,
        subscription.workflowId,
        subscription.workflowRevision,
      );
      if (!workflow) {
        await finish({
          status: "failed",
          error: "Pinned workflow revision is unavailable",
        });
        return;
      }
      if (this.dependencies.matches && !(await this.dependencies.matches(event, subscription, workflow))) {
        await finish({ status: "filtered" });
        return;
      }

      const inputs = {
        data: event.data,
        event: {
          id: event.id,
          teamId: event.teamId,
          type: event.type,
          schemaVersion: event.schemaVersion,
          source: event.source,
          occurredAt: event.occurredAt,
          recordedAt: event.recordedAt,
          correlationId: event.correlationId,
          causationId: event.causationId,
          idempotencyKey: event.idempotencyKey,
        },
      };
      const result = await this.dependencies.admitInvocation({
        teamId: delivery.teamId,
        workflowId: subscription.workflowId,
        revision: subscription.workflowRevision,
        inputs,
        context: {
          eventId: event.id,
          deliveryId: delivery.id,
          correlationId: event.correlationId,
          causationId: event.causationId,
        },
        source: {
          eventId: event.id,
          deliveryId: delivery.id,
          correlationId: event.correlationId,
          causationId: event.causationId,
        },
        idempotencyKey: `domain-event-delivery:${delivery.id}`,
      });
      await finish({ status: "admitted", invocationId: result.invocationId });
    } catch {
      await finish({
        status: "pending",
        error: "Domain event invocation could not be admitted",
      });
    }
  }
}
