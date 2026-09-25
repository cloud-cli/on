
         import { onDestroy, onInit, ref, templateRef } from '@li3/web';
         import { apiFetch } from '@app/api-client.mjs';
         import { diffLines } from 'diff';

        export default function () {
          const page = document.body.dataset.page;
           const params = new URLSearchParams(window.location.search);
           const initialId = params.get('id') || '';
           const initialRevision = params.get('revision') ? Number(params.get('revision')) : null;
          const readOnly = Boolean(initialRevision);
          const workflows = ref([]);
          const secrets = ref([]);
          const source = ref('');
          const validation = ref({ valid: true });
           const savedSource = ref('');
           const revision = ref(null);
           const revisionDialogOpen = ref(false);
           const revisionNumber = ref(0);
           const revisionDiffHtml = ref('');
           const revisionError = ref('');
           const revisionLoading = ref(false);
           const aiDialogOpen = ref(false);
           const aiRequest = ref('');
           const aiLoading = ref(false);
           const aiError = ref('');
           const aiSuggestion = ref('');
           const aiDiffHtml = ref('');
          const workflowId = ref('');
          const enabled = ref(true);
          const savedEnabled = ref(true);
          const selectedId = ref('');
           const secretName = ref('');
           const secretValue = ref('');
           const fileMode = ref(false);
           const secretFileName = ref('');
           const secretFileData = ref('');
          const notice = ref('');
          const noticeError = ref(false);
          const busy = ref(false);
           const secretValueInput = templateRef('secretValueInput');
            const secretFileInput = templateRef('secretFileInput');
           const secretForm = templateRef('secretForm');
          const helpContent = templateRef('helpContent');
          const helpLoaded = ref(false);
          const helpLoading = ref(false);
          let validationTimer;

          const showNotice = (message, error = false) => {
            notice.value = message;
            noticeError.value = error;
          };

          const api = async (url, options = {}) => {
             const response = await apiFetch(url, {
              headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
              ...options,
            });
            const body = response.status === 204 ? null : await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
            return body;
          };

          const derivedId = () =>
            source.value
              .match(/^\s*(?:id:\s*([^\n]+)|name:\s*([^\n]+))/m)
              ?.slice(1)
              .find(Boolean)
              ?.trim()
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '-')
              .replace(/(^-|-$)/g, '') || '';

          const run = async (action) => {
            if (busy.value) return;

            busy.value = true;

            try {
              await action();
            } catch (error) {
              showNotice(error.message, true);
            } finally {
              busy.value = false;
            }
          };

          const loadWorkflows = async () => {
            workflows.value = (await api('/api/workflows')).workflows;
          };

          const loadSecrets = async () => {
            secrets.value = (await api('/api/secrets')).secrets;
          };

          const openWorkflow = async (id) => {
            const workflowUrl = initialRevision
              ? `/api/workflows/${id}?revision=${initialRevision}`
              : `/api/workflows/${id}`;
            const workflow = await api(workflowUrl);
            selectedId.value = workflow.id;
            workflowId.value = workflow.id;
            source.value = workflow.sourceYaml;
            savedSource.value = workflow.sourceYaml;
            enabled.value = workflow.enabled;
             savedEnabled.value = workflow.enabled;
             revision.value = workflow.revision || null;
          };

           const validateSource = async () => {
             return api('/api/workflows/validate', {
               method: 'POST',
               body: JSON.stringify({ sourceYaml: source.value }),
             });
           };

           const validate = (ms = 1000) => {
             if (page !== 'editor') return;

             clearTimeout(validationTimer);
             validationTimer = setTimeout(() => {
               validation.value = { ...validation.value, running: true, error: '' };
               void validateSource()
                 .then((result) => {
                   validation.value = { ...result, running: false };
                 })
                 .catch((error) => {
                   validation.value = { valid: false, running: false, error: error.message };
                   
                 });
             }, ms);
           };

          const save = () =>
            run(async () => {
              const id = workflowId.value.trim() || derivedId();
              if (!id) throw new Error('Set an ID or add a workflow name first.');
              if (
                initialId &&
                id === selectedId.value &&
                source.value === savedSource.value &&
                enabled.value === savedEnabled.value
              ) {
                showNotice('No changes to save.');
                return;
              }
              const workflow = await api(`/api/workflows/${id}`, {
                method: 'PUT',
                body: JSON.stringify({ sourceYaml: source.value, enabled: enabled.value }),
              });
              selectedId.value = workflow.id;
              workflowId.value = workflow.id;
              savedSource.value = source.value;
               savedEnabled.value = enabled.value;
               revision.value = workflow.revision;
              showNotice(`Saved ${workflow.id} as draft revision ${workflow.revision}.`);
              if (!initialId) history.replaceState(null, '', `/workflows/${workflow.id}`);
            });
          const publish = () =>
            run(async () => {
              const id = workflowId.value.trim() || selectedId.value;
              if (!id) throw new Error('Save a workflow before publishing it.');
              const workflow = await api(`/api/workflows/${id}/publish`, { method: 'POST' });
               selectedId.value = workflow.id;
               revision.value = workflow.revision;
               showNotice(`Published ${workflow.id} revision ${workflow.revision}.`);
            });
          const remove = () =>
            run(async () => {
              const id = workflowId.value.trim() || selectedId.value;
              if (!id || !confirm(`Delete ${id} and all of its revisions?`)) return;
              await api(`/api/workflows/${id}`, { method: 'DELETE' });
              window.location.href = '/workflows';
            });
           const saveSecret = () =>
             run(async () => {
               const name = secretName.value.trim();
               if (!name || (fileMode.value ? !secretFileData.value : !secretValue.value)) throw new Error(fileMode.value ? 'Choose a file first.' : 'Set a secret value first.');
               await api(`/api/secrets/${name}`, {
                 method: 'PUT',
                 body: JSON.stringify(fileMode.value ? { value: secretFileData.value, encoding: 'base64', originalName: secretFileName.value } : { value: secretValue.value, encoding: 'utf8' }),
               });
               secretValue.value = '';
               secretFileName.value = '';
               secretFileData.value = '';
               fileMode.value = false;
               if (secretFileInput.value) secretFileInput.value.value = '';
               if (secretForm.value) secretForm.value.open = false;
              await loadSecrets();
              showNotice(`Saved ${name}.`);
            });
           const removeSecret = (requestedName = '') =>
             run(async () => {
               const name = requestedName || secretName.value.trim();
               if (!name || !confirm(`Delete ${name}?`)) return;
               await api(`/api/secrets/${name}`, { method: 'DELETE' });
               if (secretName.value.trim() === name) {
                 secretName.value = '';
                 secretValue.value = '';
                 secretFileName.value = '';
                 secretFileData.value = '';
                 fileMode.value = false;
                 if (secretFileInput.value) secretFileInput.value.value = '';
               }
              await loadSecrets();
              showNotice(`Deleted ${name}.`);
            });
          const setSource = (value) => {
            source.value = value;
            validate();
          };
          const setWorkflowId = (event) => {
            workflowId.value = event.target.value;
          };
          const setEnabled = (event) => {
            enabled.value = event.target.checked;
          };
          const setSecretName = (event) => {
            secretName.value = event.target.value;
          };
           const setSecretValue = (event) => {
             secretValue.value = event.target.value;
             fileMode.value = false;
             if (secretValue.value) {
               secretFileName.value = '';
               secretFileData.value = '';
               if (secretFileInput.value) secretFileInput.value.value = '';
             }
           };
           const setFileMode = (event) => {
             fileMode.value = event.target.checked;
             if (!fileMode.value) {
               secretFileName.value = '';
               secretFileData.value = '';
               if (secretFileInput.value) secretFileInput.value.value = '';
             } else {
               secretValue.value = '';
             }
           };
           const setSecretFile = async (event) => {
             const file = event.target.files?.[0];
             if (!file) return;
             const bytes = new Uint8Array(await file.arrayBuffer());
             let binary = '';
             for (let index = 0; index < bytes.length; index += 0x8000) {
               binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
             }
             secretFileName.value = file.name;
             secretFileData.value = btoa(binary);
             secretValue.value = '';
          };
          const selectSecret = (name) => {
            secretName.value = name;
            secretValueInput.value?.focus();
          };
          const visitWorkflow = (id) => {
            window.location.href = `/workflows/${id}`;
          };
           const loadHelp = async (event) => {
            if (!event.target.open || helpLoaded.value || helpLoading.value || !helpContent.value) return;
            helpLoading.value = true;
            helpContent.value.textContent = 'Loading workflow syntax help...';
            try {
              const response = await fetch('/help?embed=1', { headers: { accept: 'text/html' } });
              if (!response.ok) throw new Error(`Help request failed: ${response.status}`);
              const html = await response.text();
              const parsed = new DOMParser().parseFromString(html, 'text/html');
              const sourceNodes = [
                ...Array.from(parsed.head.querySelectorAll('style')),
                ...Array.from(parsed.body.childNodes),
              ];
              const nodes = sourceNodes.map((node) => document.importNode(node, true));
              helpContent.value.replaceChildren(...nodes);
              helpLoaded.value = true;
            } catch (error) {
              helpContent.value.textContent = 'Unable to load workflow syntax help.';
              console.error(error);
            } finally {
              helpLoading.value = false;
            }
           };

           const escapeRevisionHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || '');
           const renderRevisionDiff = (previousSource, currentSource) => {
             if (previousSource === null) return `<span class="text-emerald-300">+ ${escapeRevisionHtml(currentSource)}</span>\n`;
             return diffLines(previousSource, currentSource).map((part) => {
               const className = part.added ? 'text-emerald-300 bg-emerald-500/10' : part.removed ? 'text-rose-300 bg-rose-500/10' : 'text-gray-300';
               const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
               return part.value.split('\n').filter((line, index, lines) => index < lines.length - 1 || line).map((line) => `<span class="block ${className}">${prefix}${escapeRevisionHtml(line)}</span>`).join('');
             }).join('');
           };
           const openRevisionDialog = async () => {
             if (!revision.value) return;
             revisionNumber.value = revision.value;
             revisionDiffHtml.value = '';
             revisionError.value = '';
             revisionDialogOpen.value = true;
             await loadRevisionDiff(revision.value);
           };
           const closeRevisionDialog = () => {
             revisionDialogOpen.value = false;
           };
           const loadRevisionDiff = async (number) => {
             revisionLoading.value = true;
             revisionError.value = '';
             try {
               const current = await api(`/api/workflows/${selectedId.value}?revision=${number}`);
               const previous = number > 1 ? await api(`/api/workflows/${selectedId.value}?revision=${number - 1}`) : null;
               revisionDiffHtml.value = renderRevisionDiff(previous?.sourceYaml ?? null, current.sourceYaml);
             } catch (error) {
               revisionError.value = error.message;
             } finally {
               revisionLoading.value = false;
             }
           };
           const navigateRevision = async (offset) => {
             if (!selectedId.value || revisionLoading.value) return;
             const target = revisionNumber.value + offset;
             if (target < 1 || target > revision.value) return;
             revisionNumber.value = target;
             await loadRevisionDiff(target);
           };
           const openAiHelp = () => {
             aiRequest.value = '';
             aiError.value = '';
             aiSuggestion.value = '';
             aiDiffHtml.value = '';
             aiDialogOpen.value = true;
           };
           const closeAiHelp = () => { if (!aiLoading.value) aiDialogOpen.value = false; };
           const requestAiHelp = async () => {
             if (!aiRequest.value.trim() || aiLoading.value) return;
             aiLoading.value = true;
             aiError.value = '';
             aiDiffHtml.value = '';
             try {
              const response = await apiFetch('/api/ai/workflow-help', {
                 method: 'POST',
                 headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
                 body: JSON.stringify({ sourceYaml: source.value, request: aiRequest.value }),
               });
               if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `AI help failed: ${response.status}`); }
               const reader = response.body.getReader();
               const decoder = new TextDecoder();
               let buffer = '';
               let suggestion = '';
               while (true) {
                 const chunk = await reader.read();
                 if (chunk.done) break;
                 buffer += decoder.decode(chunk.value, { stream: true });
                 const events = buffer.split('\n\n');
                 buffer = events.pop() || '';
                 for (const event of events) {
                   const line = event.split('\n').find((value) => value.startsWith('data: '));
                   if (!line) continue;
                   const data = JSON.parse(line.slice(6));
                   if (data.error) throw new Error(data.error);
                   if (data.delta) suggestion += data.delta;
                 }
               }
               suggestion = suggestion.replace(/^```(?:yaml|yml)?\s*/i, '').replace(/\s*```$/i, '').trim();
               if (!source.value.trim()) {
                 source.value = suggestion;
                 aiDialogOpen.value = false;
                 validate();
               } else {
                 aiSuggestion.value = suggestion;
                 aiDiffHtml.value = renderRevisionDiff(source.value, suggestion);
               }
             } catch (error) {
               aiError.value = error.message;
             } finally {
               aiLoading.value = false;
             }
           };
           const acceptAiSuggestion = () => { source.value = aiSuggestion.value; aiDialogOpen.value = false; validate(); };
           const rejectAiSuggestion = () => { aiSuggestion.value = ''; aiDiffHtml.value = ''; };

          onDestroy(() => clearTimeout(validationTimer));

          onInit(() => {
             const loadPage = page === 'editor'
               ? initialId ? openWorkflow(initialId) : Promise.resolve()
               : page === 'secrets' ? loadSecrets() : loadWorkflows();
            loadPage.catch((error) => showNotice(error.message, true));
          });

           return {
             page,
             workflows,
            secrets,
             source,
             validation,
             revision,
             revisionDialogOpen,
             revisionNumber,
             revisionDiffHtml,
             revisionError,
             revisionLoading,
             aiDialogOpen,
             aiRequest,
             aiLoading,
             aiError,
             aiDiffHtml,
            workflowId,
            enabled,
            readOnly,
            selectedId,
             secretName,
             secretValue,
             fileMode,
             secretFileName,
             secretFileData,
            notice,
            noticeError,
            busy,
            validate,
            save,
            publish,
            remove,
            saveSecret,
            removeSecret,
            setSource,
            setWorkflowId,
            setEnabled,
            setSecretName,
             setSecretValue,
             setFileMode,
             setSecretFile,
            selectSecret,
            visitWorkflow,
             loadHelp,
             openRevisionDialog,
             closeRevisionDialog,
             navigateRevision,
             openAiHelp,
             closeAiHelp,
             requestAiHelp,
             acceptAiSuggestion,
             rejectAiSuggestion,
          };
        }
      
