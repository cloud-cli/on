import type { StepReport } from './types.js';

export type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function buildAiHelpMessages(
  workflowSourceYaml: string,
  steps: StepReport[],
  logs: Record<string, string>,
  failedStepId: string,
  redact: (value: string) => string,
  question = `Please explain why step '${failedStepId}' failed and list the most useful next steps to fix or verify the problem.`,
  conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): AiMessage[] {
  const failedIndex = steps.findIndex((step) => step.id === failedStepId);
  const relevantSteps = steps.slice(0, failedIndex >= 0 ? failedIndex + 1 : steps.length);
  const logBlock = relevantSteps
    .map((step) => `===== STEP ${step.id} (${step.status}) =====\n${redact(logs[step.id] || step.logContent || '(no log output)')}`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: 'You are an expert assistant helping diagnose an On CI workflow runner failure. Explain the likely root cause using only the supplied workflow and logs. Suggest concrete, safe next steps. Never invent hidden values or secrets.',
    },
    {
      role: 'user',
      content: `The workflow source YAML is:\n\n\`\`\`yaml\n${redact(workflowSourceYaml)}\n\`\`\``,
    },
    {
      role: 'user',
      content: `The logs and step results from the beginning through the failed step are:\n\n\`\`\`text\n${logBlock}\n\`\`\``,
    },
    ...conversation,
    { role: 'user', content: question },
  ];
}

export function createAiRequest(model: string, messages: AiMessage[]) {
  return { model, messages };
}

export async function requestAiHelp(apiUrl: string, apiKey: string | undefined, requestBody: ReturnType<typeof createAiRequest>): Promise<string> {
  const endpoint = apiUrl.endsWith('/chat/completions') ? apiUrl : `${apiUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`AI help request failed with HTTP ${response.status}`);
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI help returned no response');
  return content;
}
