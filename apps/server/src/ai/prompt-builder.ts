import {
  AI_ANALYSIS_PROMPT_VERSION,
  sanitizeUrlForLog,
  type IncidentSeverity,
  type IncidentStatus,
} from '@rain/shared';
import type {
  IncidentAnalysisContext,
  IncidentCheckSummary,
} from '../incidents/incident-repository.js';

export interface BuiltIncidentPrompt {
  promptVersion: typeof AI_ANALYSIS_PROMPT_VERSION;
  systemInstruction: string;
  userPrompt: string;
  sanitizedContext: {
    monitorName: string;
    incidentStatus: IncidentStatus;
    incidentSeverity: IncidentSeverity;
    checksAnalyzed: number;
    failedChecksInWindow: number;
    avgLatencyMs: number | null;
  };
}

/**
 * Strips any accidental credential-like substrings (Bearer tokens, query secrets, basic auth)
 * before telemetry or operator text leaves RAIN toward an LLM provider.
 */
export function sanitizePromptText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function serializeCheck(check: IncidentCheckSummary) {
  return {
    checkedAt: check.checkedAt.toISOString(),
    source: check.source,
    outcome: check.outcome,
    statusCode: check.statusCode,
    latencyMs: check.latencyMs,
    failureReason: check.failureReason,
    errorMessage: check.errorMessage ? sanitizePromptText(check.errorMessage) : null,
  };
}

export const SYSTEM_INSTRUCTION = [
  `You are RAIN Incident Analyst (${AI_ANALYSIS_PROMPT_VERSION}), a site reliability engineering assistant inside RAIN API Observatory.`,
  'Your job is to analyze an API outage incident using ONLY the sanitized telemetry payload provided.',
  '',
  'STRICT EVIDENCE & GROUNDING RULES:',
  '1. Distinguish observed evidence from hypotheses:',
  '   - Every item in "supportingEvidence" MUST cite concrete values directly from the telemetry (e.g., statusCode, failureReason, latencyMs, timestamps, consecutiveFailures, or windowStats).',
  '   - Every item in "potentialCauses" MUST be framed as a plausible hypothesis, never stated as proven fact.',
  '2. Never invent unobserved infrastructure causes:',
  '   - RAIN only observes black-box HTTP probes from outside the target API. Do NOT claim knowledge of internal target server logs, database deadlocks, memory leaks, or deployment commits unless explicitly mentioned in the sanitized error message or operator focus question.',
  '3. Express calibrated uncertainty:',
  '   - Set "confidenceLevel" to LOW when check samples are sparse (< 3 checks) or error reasons are generic; MEDIUM when HTTP status/network patterns are consistent; HIGH only when telemetry is unambiguous.',
  '   - Always list explicit gaps in "limitations" (for example: no access to target application logs, request bodies, or upstream DNS/network traces).',
  '4. Advisory only:',
  '   - Provide practical, safe investigation steps and recommended actions for the on-call engineer.',
  '5. Return valid JSON matching the requested schema with no markdown code fences or commentary outside JSON.',
].join('\n');

/**
 * Builds a deterministic, versioned, secret-free prompt from PostgreSQL JOIN context.
 */
export function buildIncidentAnalysisPrompt(
  ctx: IncidentAnalysisContext,
  focusQuestion?: string,
): BuiltIncidentPrompt {
  const safeTarget = `${ctx.monitor.method} ${sanitizeUrlForLog(ctx.monitor.url)}`;
  const payload = {
    promptVersion: AI_ANALYSIS_PROMPT_VERSION,
    incident: {
      id: ctx.incident.id,
      title: sanitizePromptText(ctx.incident.title),
      description: ctx.incident.description ? sanitizePromptText(ctx.incident.description) : null,
      severity: ctx.incident.severity,
      status: ctx.incident.status,
      startedAt: ctx.incident.startedAt.toISOString(),
      acknowledgedAt: ctx.incident.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: ctx.incident.resolvedAt?.toISOString() ?? null,
    },
    monitor: {
      name: ctx.monitor.name,
      target: safeTarget,
      expectedStatusCode: ctx.monitor.expectedStatusCode,
      timeoutMs: ctx.monitor.timeoutMs,
      latencyThresholdMs: ctx.monitor.latencyThresholdMs,
      checkIntervalSeconds: ctx.monitor.checkIntervalSeconds,
      currentStatus: ctx.monitor.currentStatus,
      consecutiveFailures: ctx.monitor.consecutiveFailures,
      consecutiveSuccesses: ctx.monitor.consecutiveSuccesses,
    },
    triggerCheck: ctx.triggerCheck ? serializeCheck(ctx.triggerCheck) : null,
    resolvedByCheck: ctx.resolvedByCheck ? serializeCheck(ctx.resolvedByCheck) : null,
    recentChecks: ctx.recentChecks.map(serializeCheck),
    last24hWindowStats: ctx.windowStats,
    operatorFocusQuestion: focusQuestion ? sanitizePromptText(focusQuestion) : null,
  };

  const userPrompt = [
    'Analyze the following sanitized RAIN incident telemetry and return the structured JSON report.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');

  return {
    promptVersion: AI_ANALYSIS_PROMPT_VERSION,
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt,
    sanitizedContext: {
      monitorName: ctx.monitor.name,
      incidentStatus: ctx.incident.status as IncidentStatus,
      incidentSeverity: ctx.incident.severity as IncidentSeverity,
      checksAnalyzed: ctx.recentChecks.length,
      failedChecksInWindow: ctx.windowStats.failedChecks,
      avgLatencyMs: ctx.windowStats.avgLatencyMs,
    },
  };
}
