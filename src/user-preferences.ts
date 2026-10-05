import db from "./db-client.js";

export class UserPreferencesRepository {
  async init() {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT NOT NULL,
        preference TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, preference)
      )
    `);
  }

  async getTimezone(userId: string): Promise<string | null> {
    const row = await db.get("SELECT value FROM user_preferences WHERE user_id = ? AND preference = 'timezone'", [
      userId,
    ]);
    return typeof row?.value === "string" ? row.value : null;
  }

  async setTimezone(userId: string, timezone: string): Promise<void> {
    await db.run(
      `INSERT INTO user_preferences (user_id, preference, value) VALUES (?, 'timezone', ?)
       ON CONFLICT(user_id, preference) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [userId, timezone],
    );
  }
}
