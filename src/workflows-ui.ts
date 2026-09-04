import template from './workflows-ui.html?raw';

export function generateWorkflowManagementHtml(page: 'list' | 'editor', workflowId = ''): string {
  return template
    .replace('__WORKFLOW_PAGE__', page)
    .replace('__WORKFLOW_ID__', JSON.stringify(workflowId));
}
