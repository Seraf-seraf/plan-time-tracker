import { appError, requireOwner } from './shared/index.js';
import { apiRoute, mcpRoute, publicView, workerError } from './transport/index.js';
import { configuredDatabase } from '../tracker-db/index.js';
import { uiHtml } from './ui/index.js';

function createWorker(clock) {
  const getNow = typeof clock === 'function' ? clock : () => Date.now();
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      try {
        const now = getNow();
        env = { ...env, DB: configuredDatabase(env) };
        if (url.pathname === '/mcp') return await mcpRoute(request, env, now, ctx, getNow);
        if (url.pathname.startsWith('/api/')) {
          const response = await apiRoute(request, env, url, 'ui', now, getNow, ctx);
          return new Response(JSON.stringify(publicView(await response.json())), {
            status: response.status,
            headers: response.headers,
          });
        }
        if (request.method !== 'GET' && request.method !== 'HEAD')
          throw appError('NOT_FOUND', 'Маршрут не найден.', 404);
        requireOwner(request);
        return new Response(uiHtml(), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'private, no-store',
            'content-security-policy':
              "default-src 'none'; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'x-frame-options': 'DENY',
          },
        });
      } catch (error) {
        return workerError(error);
      }
    },
  };
}

export { createWorker };
export {
  AppError,
  payloadHash,
  checkTimeZone,
  parsePlanCreatedAt,
  zonedDateStartMs,
  inclusiveDateRange,
  calculateActiveMs,
  calculateCalendarMs,
  median,
} from './shared/index.js';
export {
  fitAtlmOls,
  predictAtlmOls,
  fitAtlmRidge,
  predictAtlmRidge,
  fitAtlm,
  predictAtlm,
  selectHybridHistory,
  selectHybridEvaluationCases,
  selectHybridEngine,
  evaluateHybridBaseCase,
  summarizeHybridCase,
  summarizeHybridAtlmEvaluation,
  evaluateHybridAtlmChronologically,
  fitHybridAtlm,
  predictHybridAtlm,
  normalizeAgentTask,
  fitAtlmV4Preprocessor,
  encodeAtlmV4Features,
  fitAtlmV4Regression,
  predictAtlmV4Regression,
  fitAtlmBayesian,
  predictAtlmBayesian,
  fitAtlmResidualQuantile,
  predictAtlmResidualQuantile,
  fitAtlmResidualQuantiles,
  combineAtlmQuantileInterval,
  predictAtlmResidualInterval,
  evaluateAtlmIntervalCandidates,
  summarizeAtlmV4Metrics,
  selectAtlmIntervalEngine,
  AGENT_TASK_SCHEMA,
} from './atlm/model.js';
export {
  readAtlmSampleSource,
  claimAtlmJob,
  persistAtlmSample,
  atlmSampleView,
  readAtlmSamples,
} from './atlm/sample.js';
export {
  parsePlanDocument,
  executeCommand,
  buildStepAnalytics,
  buildAnalytics,
} from './tracker/index.js';
export {
  ATLM_RETRAIN_EVERY_NEW_PLANS,
  predictWithActiveModel,
  getEstimationModelStatus,
  processEstimationTraining,
  scheduleAtlmTraining,
} from './atlm/training.js';
export { resolveUiTimeZone } from './ui/time-zones.js';

export default createWorker();
