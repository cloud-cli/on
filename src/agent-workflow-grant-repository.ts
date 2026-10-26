import db from "./db-client.js";

export type AgentWorkflowGrant = {
  teamId: string;
  agentPrincipalId: string;
  workflowId: string;
  grantedBy: string;
  createdAt: string;
};

/** Workspace-scoped grants contain identifiers and audit metadata only. */
export class AgentWorkflowGrantRepository {
  async list(teamId: string, agentPrincipalId?: string): Promise<AgentWorkflowGrant[]> {
    const rows = agentPrincipalId
      ? await db.all(
          `SELECT team_id, agent_principal_id, workflow_id, granted_by, created_at
           FROM agent_workflow_grants WHERE team_id = ? AND agent_principal_id = ? ORDER BY created_at`,
          [teamId, agentPrincipalId],
        )
      : await db.all(
          `SELECT team_id, agent_principal_id, workflow_id, granted_by, created_at
           FROM agent_workflow_grants WHERE team_id = ? ORDER BY created_at`,
          [teamId],
        );
    return rows.map((row: any) => ({
      teamId: row.team_id,
      agentPrincipalId: row.agent_principal_id,
      workflowId: row.workflow_id,
      grantedBy: row.granted_by,
      createdAt: row.created_at,
    }));
  }

  async has(teamId: string, agentPrincipalId: string, workflowId: string): Promise<boolean> {
    return Boolean(
      await db.get(
        `SELECT 1 FROM agent_workflow_grants
         WHERE team_id = ? AND agent_principal_id = ? AND workflow_id = ?`,
        [teamId, agentPrincipalId, workflowId],
      ),
    );
  }

  async grant(teamId: string, agentPrincipalId: string, workflowId: string, grantedBy: string): Promise<void> {
    await db.run(
      `INSERT OR IGNORE INTO agent_workflow_grants
       (team_id, agent_principal_id, workflow_id, granted_by) VALUES (?, ?, ?, ?)`,
      [teamId, agentPrincipalId, workflowId, grantedBy],
    );
  }

  async revoke(teamId: string, agentPrincipalId: string, workflowId: string): Promise<void> {
    await db.run(
      `DELETE FROM agent_workflow_grants
       WHERE team_id = ? AND agent_principal_id = ? AND workflow_id = ?`,
      [teamId, agentPrincipalId, workflowId],
    );
  }
}

export const agentWorkflowGrantRepository = new AgentWorkflowGrantRepository();
