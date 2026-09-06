import webpush from 'web-push';
import db from './db-client.js';
import type { RunnerConfig } from './types.js';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class PushRepository {
  constructor(private readonly config: RunnerConfig) {}

  get publicKey(): string | undefined {
    return this.config.push?.publicKey;
  }

  async save(subscription: PushSubscriptionInput): Promise<void> {
    await db.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth],
    );
  }

  async remove(endpoint: string): Promise<void> {
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  }

  async notify(job: { id: number; workflow_id: string; status: string }): Promise<void> {
    if (!this.config.push || !['success', 'failed', 'cancelled'].includes(job.status)) return;
    webpush.setVapidDetails(this.config.push.subject, this.config.push.publicKey, this.config.push.privateKey);
    const subscriptions = await db.all('SELECT endpoint, p256dh, auth FROM push_subscriptions');
    const payload = JSON.stringify({
      title: `Job #${job.id} ${job.status}`,
      body: `${job.workflow_id} finished with status ${job.status}.`,
      url: `/runs/${job.id}`,
    });

    await Promise.all(
      subscriptions.map(async (subscription: any) => {
        try {
          await webpush.sendNotification(
            { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            payload,
          );
        } catch (error: any) {
          if (error.statusCode === 404 || error.statusCode === 410) await this.remove(subscription.endpoint);
          else console.error(`Unable to send push notification to ${subscription.endpoint}:`, error.message);
        }
      }),
    );
  }
}
