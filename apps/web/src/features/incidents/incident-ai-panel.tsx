import { AI_ANALYSIS_LIMITS, type AiAnalysisDocument, type AiConfidenceLevel } from '@rain/shared';
import {
  ChevronDown,
  ChevronUp,
  History,
  MessageSquarePlus,
  Pencil,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/page';
import { Alert } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge, Textarea } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime, formatRelative } from '@/features/monitors/format';
import {
  useDeleteIncidentAiAnalysis,
  useGenerateIncidentAiAnalysis,
  useIncidentAiAnalyses,
  useUpdateIncidentAiAnalysis,
} from './ai-analysis-api';

const CONFIDENCE_TONE: Record<AiConfidenceLevel, 'success' | 'warning' | 'neutral'> = {
  HIGH: 'success',
  MEDIUM: 'warning',
  LOW: 'neutral',
};

const CONFIDENCE_LABEL: Record<AiConfidenceLevel, string> = {
  HIGH: 'High confidence',
  MEDIUM: 'Medium confidence',
  LOW: 'Low confidence',
};

function SectionList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="grid gap-1.5">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      <ul className="grid gap-1.5 pl-4 text-sm leading-relaxed list-disc">
        {items.map((item, idx) => (
          <li key={idx}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function AnalysisCard({
  item,
  incidentId,
  onRequestDelete,
}: {
  item: AiAnalysisDocument;
  incidentId: string;
  onRequestDelete: (id: string) => void;
}) {
  const update = useUpdateIncidentAiAnalysis(incidentId);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState(item.operatorNotes ?? '');

  function saveNotes(e: FormEvent) {
    e.preventDefault();
    update.mutate(
      { analysisId: item.id, patch: { operatorNotes: notesDraft } },
      {
        onSuccess: () => {
          toast.success('Analysis notes saved');
          setEditingNotes(false);
        },
      },
    );
  }

  function setHelpful(value: boolean) {
    const next = item.helpful === value ? null : value;
    update.mutate({ analysisId: item.id, patch: { helpful: next } });
  }

  return (
    <div className="grid gap-5 rounded-xl border border-border bg-muted/20 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={CONFIDENCE_TONE[item.analysis.confidenceLevel]}>
            {CONFIDENCE_LABEL[item.analysis.confidenceLevel]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {item.model} · {item.promptVersion} ·{' '}
            <time dateTime={item.createdAt} title={formatRelative(item.createdAt)}>
              {formatDateTime(item.createdAt)}
            </time>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant={item.helpful === true ? 'default' : 'outline'}
            size="sm"
            aria-label="Mark analysis helpful"
            aria-pressed={item.helpful === true}
            disabled={update.isPending}
            onClick={() => setHelpful(true)}
          >
            <ThumbsUp aria-hidden />
          </Button>
          <Button
            type="button"
            variant={item.helpful === false ? 'default' : 'outline'}
            size="sm"
            aria-label="Mark analysis not helpful"
            aria-pressed={item.helpful === false}
            disabled={update.isPending}
            onClick={() => setHelpful(false)}
          >
            <ThumbsDown aria-hidden />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Edit analysis notes"
            onClick={() => {
              setNotesDraft(item.operatorNotes ?? '');
              setEditingNotes((v) => !v);
            }}
          >
            <Pencil aria-hidden /> Notes
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Delete analysis"
            onClick={() => onRequestDelete(item.id)}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>

      {item.focusQuestion && (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Focus question:</span>{' '}
          {item.focusQuestion}
        </div>
      )}

      <div className="grid gap-1.5">
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Incident summary
        </h4>
        <p className="text-sm leading-relaxed">{item.analysis.incidentSummary}</p>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <SectionList
          title="Supporting evidence (observed)"
          items={item.analysis.supportingEvidence}
        />
        <SectionList title="Potential causes (hypotheses)" items={item.analysis.potentialCauses} />
        <SectionList
          title="Suggested investigation steps"
          items={item.analysis.suggestedInvestigationSteps}
        />
        <SectionList title="Recommended actions" items={item.analysis.recommendedActions} />
      </div>

      <SectionList title="Limitations & telemetry gaps" items={item.analysis.limitations} />

      <div className="text-xs text-muted-foreground">
        Snapshot: {item.contextSnapshot.checksAnalyzed} checks inspected,{' '}
        {item.contextSnapshot.failedChecksInWindow} failed in 24h
        {item.contextSnapshot.avgLatencyMs !== null
          ? `, ${item.contextSnapshot.avgLatencyMs} ms avg latency`
          : ''}
        . Advisory only — RAIN monitor health, incidents, and notifications remain unchanged.
      </div>

      {update.isError && <Alert variant="error">{update.error.message}</Alert>}

      {editingNotes ? (
        <form onSubmit={saveNotes} className="grid gap-2 border-t border-border pt-3">
          <Label htmlFor={`ai-notes-${item.id}`}>Operator notes</Label>
          <Textarea
            id={`ai-notes-${item.id}`}
            className="font-sans"
            value={notesDraft}
            maxLength={AI_ANALYSIS_LIMITS.operatorNotesMaxLength}
            placeholder="Record verification findings or follow-up notes..."
            onChange={(e) => setNotesDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={update.isPending}>
              {update.isPending && <Spinner label="Saving" />}
              Save notes
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={update.isPending}
              onClick={() => setEditingNotes(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        item.operatorNotes && (
          <div className="border-t border-border pt-3 text-sm">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Operator notes
            </span>
            <p className="mt-1 whitespace-pre-wrap">{item.operatorNotes}</p>
          </div>
        )
      )}
    </div>
  );
}

export function IncidentAiPanel({ incidentId }: { incidentId: string }) {
  const analyses = useIncidentAiAnalyses(incidentId);
  const generate = useGenerateIncidentAiAnalysis(incidentId);
  const remove = useDeleteIncidentAiAnalysis(incidentId);

  const [showFocusInput, setShowFocusInput] = useState(false);
  const [focusQuestion, setFocusQuestion] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const items = analyses.data?.items ?? [];
  const capability = analyses.data?.capability;
  const latest = items[0];
  const previous = items.slice(1);

  function handleGenerate() {
    const trimmed = focusQuestion.trim();
    generate.mutate(trimmed ? { focusQuestion: trimmed } : {}, {
      onSuccess: () => {
        toast.success('AI incident analysis generated');
        setFocusQuestion('');
        setShowFocusInput(false);
      },
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            AI Incident Analysis
          </CardTitle>
          <CardDescription>
            Advisory root-cause hypotheses grounded in PostgreSQL monitor & check telemetry.
          </CardDescription>
        </div>
        {capability?.available && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowFocusInput((v) => !v)}
              disabled={generate.isPending}
            >
              <MessageSquarePlus aria-hidden />
              {showFocusInput ? 'Hide focus' : 'Add focus'}
            </Button>
            <Button type="button" size="sm" onClick={handleGenerate} disabled={generate.isPending}>
              {generate.isPending ? <Spinner label="Analyzing" /> : <Sparkles aria-hidden />}
              {generate.isPending ? 'Generating…' : 'Generate AI Analysis'}
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="grid gap-4">
        {showFocusInput && capability?.available && (
          <div className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3">
            <Label htmlFor="ai-focus-question">Optional focus question</Label>
            <Textarea
              id="ai-focus-question"
              className="min-h-16 font-sans"
              value={focusQuestion}
              maxLength={AI_ANALYSIS_LIMITS.focusQuestionMaxLength}
              placeholder="e.g., Did latency climb before the 503 responses started?"
              onChange={(e) => setFocusQuestion(e.target.value)}
            />
          </div>
        )}

        {generate.isError && <Alert variant="error">{generate.error.message}</Alert>}

        {analyses.isPending ? (
          <div className="grid gap-3" aria-busy>
            <Skeleton className="h-24" />
            <Skeleton className="h-16" />
          </div>
        ) : analyses.isError ? (
          <ErrorState
            title="Couldn't load AI analyses"
            error={analyses.error}
            onRetry={() => void analyses.refetch()}
            retrying={analyses.isFetching}
          />
        ) : (
          <>
            {capability && !capability.available && (
              <Alert variant="info">
                <p className="font-medium">AI analysis unavailable</p>
                <p className="text-muted-foreground">
                  {capability.reason ??
                    'Configure GEMINI_API_KEY and MONGODB_URI on the server to enable AI incident analysis.'}
                </p>
              </Alert>
            )}

            {items.length === 0 ? (
              capability?.available ? (
                <p className="text-sm text-muted-foreground">
                  No AI analysis generated for this incident yet. Click{' '}
                  <strong className="font-medium text-foreground">Generate AI Analysis</strong> to
                  inspect recent health check telemetry.
                </p>
              ) : null
            ) : (
              <div className="grid gap-4">
                {latest && (
                  <AnalysisCard
                    key={latest.id}
                    item={latest}
                    incidentId={incidentId}
                    onRequestDelete={setDeleteTargetId}
                  />
                )}

                {previous.length > 0 && (
                  <div className="grid gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-self-start"
                      onClick={() => setShowHistory((v) => !v)}
                    >
                      <History aria-hidden />
                      {showHistory
                        ? `Hide previous analyses (${previous.length})`
                        : `Show previous analyses (${previous.length})`}
                      {showHistory ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
                    </Button>
                    {showHistory && (
                      <div className="grid gap-4">
                        {previous.map((item) => (
                          <AnalysisCard
                            key={item.id}
                            item={item}
                            incidentId={incidentId}
                            onRequestDelete={setDeleteTargetId}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (remove.isPending) return;
          if (!open) {
            remove.reset();
            setDeleteTargetId(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Delete AI analysis?</AlertDialogTitle>
          <AlertDialogDescription>
            This AI analysis document and any operator notes on it will be permanently removed from
            history.
          </AlertDialogDescription>
          {remove.isError && <Alert variant="error">{remove.error.message}</Alert>}
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" disabled={remove.isPending}>
                Cancel
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending || !deleteTargetId}
              onClick={() => {
                if (!deleteTargetId) return;
                remove.mutate(deleteTargetId, {
                  onSuccess: () => {
                    toast.success('AI analysis deleted');
                    setDeleteTargetId(null);
                  },
                });
              }}
            >
              {remove.isPending && <Spinner label="Deleting" />}
              Delete analysis
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
