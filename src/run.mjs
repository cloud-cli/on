
         import { computed, onDestroy, onInit, ref } from '@li3/web';
          import { AnsiUp } from 'ansi_up';
          import { marked } from 'marked';
           import { apiFetch } from '@app/api-client.mjs';

        export default function setup() {
          const jobId = window.location.pathname.split('/').filter(Boolean).pop() || '';
          const report = ref({ jobId });
          const previousRuns = ref([]);
          const aiMessages = ref([]);
          const aiStepId = ref('');
          const aiQuestion = ref('');
          const aiError = ref('');
          const aiLoading = ref(false);
          const manualRestartOpen = ref(false);
          const manualRestartLoading = ref(false);
          const manualInputs = ref([]);
          let previousRunsLoaded = false;
          const now = ref(Date.now());
          const ansiUp = new AnsiUp();
          ansiUp.use_classes = false;
          let eventSource;
          let refreshTimer;
          let clockTimer;
          let refreshing = false;
          let refreshPending = false;
          const cancelling = ref(false);

          const active = computed(() => ['pending', 'running'].includes(report.value.status));
          const inputsJson = computed(() => JSON.stringify(report.value.inputs || {}, null, 2));
          const originalInputsJson = computed(() => JSON.stringify(report.value.inputs || {}, null, 2));
          const timing = computed(() => {
            if (report.value.status === 'pending') return 'Waiting for a worker';
            if (report.value.status === 'running') {
              return `Running for ${Math.max(0, now.value - Date.parse(report.value.startedAt))}ms`;
            }
            return `Finished in ${report.value.durationMs}ms`;
          });

          const upper = (value) => String(value || '').toUpperCase();
           const artifactUrl = (path) => `/api/runs/${report.value.jobId}/artifacts/${encodeURIComponent(path)}`;
           const downloadArtifact = async (event, path) => {
             event.preventDefault();
              const response = await apiFetch(artifactUrl(path));
             if (!response.ok) return;
             const link = document.createElement('a');
             link.href = URL.createObjectURL(await response.blob());
             link.download = path.split('/').pop() || 'artifact';
             link.click();
             URL.revokeObjectURL(link.href);
           };
          const loadPreviousRuns = async () => {
            if (previousRunsLoaded || !report.value.parentId) return;
            const lineage = [];
            const visited = new Set();
            let parentId = report.value.parentId;
            while (parentId && !visited.has(String(parentId)) && lineage.length < 50) {
              visited.add(String(parentId));
               const response = await apiFetch(`/api/runs/${parentId}`, { headers: { accept: 'application/json' } });
              if (!response.ok) throw new Error(`Previous run request failed: ${response.status}`);
              const parent = await response.json();
              lineage.push({ id: parent.jobId, status: parent.status, startedAt: parent.startedAt });
              parentId = parent.parentId;
            }
            previousRuns.value = lineage;
            previousRunsLoaded = true;
          };
          const stepLog = (step) => {
            if (step.status === 'skipped') return '';
            if (step.status === 'running')
              return '<span class="text-indigo-400">Step is running. Logs will appear after it finishes.</span>';
            if (step.status === 'pending') return '<span class="text-gray-500">Waiting to run.</span>';
            if (step.logContent) return ansiUp.ansi_to_html(step.logContent);
            return '<span class="text-gray-500">(No terminal log output recorded for this step)</span>';
          };
          const sanitizeAiHtml = (html) => {
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            parsed.querySelectorAll('script,style,iframe,object,embed,form').forEach((node) => node.remove());
            parsed.querySelectorAll('*').forEach((element) => {
              [...element.attributes].forEach((attribute) => {
                if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
                if (['href', 'src'].includes(attribute.name.toLowerCase()) && /^(javascript|data):/i.test(attribute.value)) element.removeAttribute(attribute.name);
              });
            });
            return parsed.body.innerHTML;
          };
          const renderAiMarkdown = (content) => sanitizeAiHtml(marked.parse(content));
          const askAi = async (step, event) => {
            event.stopPropagation();
            aiStepId.value = step.id;
            aiMessages.value = [];
            aiQuestion.value = '';
            await requestAiHelp(step.id, 'Please explain why this step failed and what I should do next.');
          };
          const requestAiHelp = async (stepId, question) => {
            aiLoading.value = true;
            aiError.value = '';
            try {
               const response = await apiFetch(`/api/runs/${report.value.jobId}/ai-help`, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify({ stepId, question, conversation: aiMessages.value }),
              });
              if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || `AI help failed: ${response.status}`);
              }
              aiMessages.value = [...aiMessages.value, { role: 'user', content: question }, { role: 'assistant', content: '' }];
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
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
                  if (data.delta) {
                    const messages = [...aiMessages.value];
                    messages[messages.length - 1] = { ...messages[messages.length - 1], content: messages[messages.length - 1].content + data.delta };
                    aiMessages.value = messages;
                  }
                  if (data.error) throw new Error(data.error);
                }
              }
              const messages = [...aiMessages.value];
              const answer = messages.at(-1);
              if (answer) messages[messages.length - 1] = { ...answer, html: renderAiMarkdown(answer.content) };
              aiMessages.value = messages;
            } catch (error) {
              aiError.value = error.message;
            } finally {
              aiLoading.value = false;
            }
          };
          const askFollowup = async () => {
            const question = aiQuestion.value.trim();
            if (!question || !aiStepId.value) return;
            aiQuestion.value = '';
            await requestAiHelp(aiStepId.value, question);
          };
          const restartJob = async () => {
              const response = await apiFetch(`/restart/${report.value.jobId}`, {
               method: 'POST',
               headers: { 'content-type': 'application/json' },
               body: JSON.stringify({ inputs: report.value.inputs || {} }),
             });
            if (response.ok) {
              const { id } = await response.json();
              location.href = `/runs/${id}`;
            }
          };
          const openManualRestart = (event) => {
            event.preventDefault();
            event.stopPropagation();
            manualInputs.value = [{ key: '', value: '' }];
            manualRestartOpen.value = true;
          };
          const closeManualRestart = () => { manualRestartOpen.value = false; };
          const addManualInput = () => { manualInputs.value = [...manualInputs.value, { key: '', value: '' }]; };
          const removeManualInput = (entry) => { manualInputs.value = manualInputs.value.filter((item) => item !== entry); };
          const setManualKey = (entry, event) => { entry.key = event.target.value; manualInputs.value = [...manualInputs.value]; };
          const setManualValue = (entry, event) => { entry.value = event.target.value; manualInputs.value = [...manualInputs.value]; };
          const restartWithInputs = async () => {
            const inputs = Object.fromEntries(manualInputs.value.filter((entry) => entry.key.trim()).map((entry) => [entry.key.trim(), entry.value]));
            manualRestartLoading.value = true;
            try {
               const response = await apiFetch(`/restart/${report.value.jobId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs }) });
              if (!response.ok) throw new Error(`Restart failed: ${response.status}`);
              const { id } = await response.json();
              location.href = `/runs/${id}`;
            } catch (error) {
              aiError.value = error.message;
            } finally {
              manualRestartLoading.value = false;
            }
          };
          const cancelJob = async () => {
            if (cancelling.value || report.value.status !== 'running') return;
            cancelling.value = true;
            try {
               const response = await apiFetch(`/api/jobs/${report.value.jobId}/cancel`, { method: 'POST' });
              if (!response.ok) throw new Error(`Cancel failed: ${response.status}`);
              await refreshRun();
            } catch (error) {
              console.error(error);
            } finally {
              cancelling.value = false;
            }
          };
          const refreshRun = async () => {
            if (refreshing) {
              refreshPending = true;
              return;
            }
            refreshing = true;

            try {
               const response = await apiFetch(`/api/runs/${jobId}`, {
                headers: { accept: 'application/json' },
              });
              if (!response.ok) throw new Error(`Run refresh failed: ${response.status}`);
              const previousStatus = report.value.status;
              const nextReport = await response.json();
              report.value = nextReport;
              document.title = `Run #${nextReport.jobId} - ${nextReport.workflowName}`;
              void loadPreviousRuns();
              if (
                ['pending', 'running'].includes(previousStatus) &&
                ['success', 'failed'].includes(nextReport.status) &&
                'Notification' in window &&
                'serviceWorker' in navigator &&
                Notification.permission === 'granted' &&
                localStorage.getItem('runner-notifications') === 'enabled'
              ) {
                const registration = await navigator.serviceWorker.ready;
                await registration.showNotification(
                  nextReport.status === 'success'
                    ? `Job #${nextReport.jobId} succeeded`
                    : `Job #${nextReport.jobId} failed`,
                  {
                    body: `${nextReport.workflowName} finished with status ${nextReport.status}.`,
                    icon: '/app-icon.svg',
                    badge: '/app-icon.svg',
                    tag: `runner-job-${nextReport.jobId}`,
                    renotify: true,
                    data: { url: `/runs/${nextReport.jobId}` },
                  },
                );
              }
            } catch (error) {
              console.error(error);
            } finally {
              refreshing = false;
              if (refreshPending) {
                refreshPending = false;
                void refreshRun();
              }
            }
          };
          const handleJobChange = (event) => {
            const data = JSON.parse(event.data || '{}');
            if (!data.jobId || String(data.jobId) === String(report.value.jobId)) void refreshRun();
          };

          onInit(() => {
            void refreshRun();
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.register('/service-worker.js').catch((error) => {
                console.error('Service worker registration failed', error);
              });
            }
            eventSource = new EventSource('/api/events');
            eventSource.addEventListener('jobs.changed', handleJobChange);
            refreshTimer = setInterval(() => {
              if (active.value) void refreshRun();
            }, 60000);
            clockTimer = setInterval(() => {
              now.value = Date.now();
            }, 1000);
          });
          onDestroy(() => {
            eventSource?.close();
            clearInterval(refreshTimer);
            clearInterval(clockTimer);
          });

           return { report, previousRuns, manualRestartOpen, manualRestartLoading, manualInputs, aiMessages, aiStepId, aiQuestion, aiError, aiLoading, inputsJson, originalInputsJson, timing, upper, artifactUrl, downloadArtifact, stepLog, askAi, askFollowup, restartJob, openManualRestart, closeManualRestart, addManualInput, removeManualInput, setManualKey, setManualValue, restartWithInputs, cancelJob, cancelling };
        }
      
