import { STATUS_PAGE_LIMITS, type StatusPage } from '@rain/shared';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  ExternalLink,
  Eye,
  Globe,
  Plus,
  SearchX,
  Trash2,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, ErrorState, PageHeader } from '@/components/page';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge, Select, Textarea } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/features/monitors/format';
import { useMonitorList } from '@/features/monitors/api';
import { MonitorStateBadges } from '@/features/monitors/status-badge';
import {
  publicUrl,
  useCreateStatusPage,
  useStatusPage,
  useStatusPageActions,
  useStatusPagePreview,
  useStatusPages,
} from './api';
import { StatusPageView } from './status-view';

const crumbs = { label: 'Status pages', to: '/app/status-pages' };
const issue = (err: unknown, path: string) =>
  err instanceof ApiError ? err.issues.find((i) => i.path === path)?.message : undefined;

function copy(text: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success('Public link copied'))
    .catch(() => toast.error("Couldn't copy; select the link and copy it manually"));
}

function PublishedBadge({ published }: { published: boolean }) {
  return (
    <Badge tone={published ? 'success' : 'neutral'}>{published ? 'Published' : 'Draft'}</Badge>
  );
}

// --- List and create ----------------------------------------------------------------------------

function CreateForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const create = useCreateStatusPage();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New status page</CardTitle>
        <CardDescription>
          Pages start as drafts: nothing is public until you publish.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate(
              { title, ...(slug.trim() && { slug: slug.trim() }) },
              {
                onSuccess: (page) => {
                  toast.success(`Created “${page.title}”`);
                  void navigate(`/app/status-pages/${page.id}`);
                },
              },
            );
          }}
        >
          <FormField
            label="Title"
            value={title}
            maxLength={STATUS_PAGE_LIMITS.titleMaxLength}
            onChange={(e) => setTitle(e.target.value)}
            error={issue(create.error, 'title')}
          />
          <FormField
            label="Public address (optional)"
            placeholder="acme-api"
            value={slug}
            maxLength={STATUS_PAGE_LIMITS.slug.max}
            onChange={(e) => setSlug(e.target.value)}
            error={issue(create.error, 'slug')}
            hint={`Lowercase letters, numbers and hyphens. Leave empty to generate one from the title. The page will be at ${window.location.origin}/status/…`}
          />
          {create.isError && !issue(create.error, 'title') && !issue(create.error, 'slug') && (
            <Alert variant="error">{create.error.message}</Alert>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner label="Creating" />}
              Create page
            </Button>
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function StatusPagesPage() {
  const list = useStatusPages();
  const [creating, setCreating] = useState(false);
  const atLimit = list.data ? list.data.quota.used >= list.data.quota.limit : false;
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Status pages"
        description="Public pages that show the health of the monitors you choose, under the names you choose."
        actions={
          !creating && (
            <Button
              onClick={() => setCreating(true)}
              disabled={atLimit}
              title={atLimit ? 'Page limit reached' : undefined}
            >
              <Plus aria-hidden /> New status page
            </Button>
          )
        }
      />
      {creating && <CreateForm onDone={() => setCreating(false)} />}
      {list.isPending ? (
        <div className="grid gap-3" aria-busy>
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : list.isError ? (
        <ErrorState
          title="Couldn't load status pages"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : list.data.items.length === 0 ? (
        !creating && (
          <Card>
            <EmptyState
              icon={Globe}
              title="No status pages yet"
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus aria-hidden /> Create a status page
                </Button>
              }
            >
              Share your APIs' health with your users: pick monitors, give them public names,
              publish.
            </EmptyState>
          </Card>
        )
      ) : (
        <ul className="grid gap-3" aria-label="Status pages">
          {list.data.items.map((p) => (
            <li key={p.id}>
              <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div className="grid min-w-0 gap-1">
                    <Link
                      to={`/app/status-pages/${p.id}`}
                      className="truncate font-medium hover:text-primary"
                    >
                      {p.title}
                    </Link>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      /status/{p.slug}
                    </span>
                  </div>
                  <span className="flex items-center gap-3 text-sm text-muted-foreground">
                    {p.monitorCount} {p.monitorCount === 1 ? 'service' : 'services'}
                    <PublishedBadge published={p.published} />
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {list.data && (
        <p className="text-xs text-muted-foreground">
          {list.data.quota.used} of {list.data.quota.limit} status pages used.
        </p>
      )}
    </div>
  );
}

// --- Editor ---------------------------------------------------------------------------------------

function InfoCard({ page }: { page: StatusPage }) {
  const { update } = useStatusPageActions(page.id);
  const [title, setTitle] = useState(page.title);
  const [description, setDescription] = useState(page.description ?? '');
  const [slug, setSlug] = useState(page.slug);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Page details</CardTitle>
        <CardDescription>Shown publicly as plain text.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate(
              { title, description, slug },
              { onSuccess: () => toast.success('Page details saved') },
            );
          }}
        >
          <FormField
            label="Title"
            value={title}
            maxLength={STATUS_PAGE_LIMITS.titleMaxLength}
            onChange={(e) => setTitle(e.target.value)}
            error={issue(update.error, 'title')}
          />
          <div className="grid gap-2">
            <Label htmlFor="status-description">Description</Label>
            <Textarea
              id="status-description"
              className="font-sans"
              maxLength={STATUS_PAGE_LIMITS.descriptionMaxLength}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            {issue(update.error, 'description') && (
              <p className="text-xs font-semibold text-status-down-fg">
                {issue(update.error, 'description')}
              </p>
            )}
          </div>
          <FormField
            label="Public address"
            value={slug}
            maxLength={STATUS_PAGE_LIMITS.slug.max}
            onChange={(e) => setSlug(e.target.value)}
            error={issue(update.error, 'slug')}
            hint={
              page.published
                ? 'Changing it breaks links to the old address immediately.'
                : undefined
            }
          />
          {update.isError &&
            !update.error.message.includes('validation') &&
            !issue(update.error, 'slug') &&
            !issue(update.error, 'title') && <Alert variant="error">{update.error.message}</Alert>}
          <div>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Spinner label="Saving" />}
              Save details
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function MonitorsCard({ page }: { page: StatusPage }) {
  const actions = useStatusPageActions(page.id);
  const monitors = useMonitorList({
    search: '',
    state: 'all',
    status: undefined,
    cursor: undefined,
    limit: 100,
  });
  const [selected, setSelected] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const available = (monitors.data?.items ?? []).filter(
    (m) => !page.monitors.some((pm) => pm.monitorId === m.id),
  );
  const ids = page.monitors.map((m) => m.monitorId);
  const busy =
    actions.reorder.isPending ||
    actions.removeMonitor.isPending ||
    actions.addMonitor.isPending ||
    actions.renameMonitor.isPending;

  function move(index: number, delta: number) {
    const next = [...ids];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    actions.reorder.mutate(next);
  }

  const error = [
    actions.addMonitor,
    actions.removeMonitor,
    actions.renameMonitor,
    actions.reorder,
  ].find((m) => m.isError)?.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Services</CardTitle>
        <CardDescription>
          The monitors this page shows, in this order. Visitors see only the public name, status,
          availability and incident times: never monitor names, URLs or error details.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {page.monitors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No services yet. Add one of your monitors below.
          </p>
        ) : (
          <ol className="grid gap-2" aria-label="Services on this page">
            {page.monitors.map((m, index) => {
              const value = names[m.monitorId] ?? m.displayName;
              return (
                <li
                  key={m.monitorId}
                  className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_auto] sm:items-end"
                >
                  <div className="grid gap-1">
                    <FormField
                      label={`Public name for ${m.monitorName}`}
                      value={value}
                      maxLength={STATUS_PAGE_LIMITS.displayNameMaxLength}
                      onChange={(e) => setNames((n) => ({ ...n, [m.monitorId]: e.target.value }))}
                    />
                    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      Monitor: {m.monitorName}{' '}
                      <MonitorStateBadges status={m.currentStatus} enabled={m.enabled} />
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {value !== m.displayName && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          actions.renameMonitor.mutate(
                            { monitorId: m.monitorId, displayName: value },
                            { onSuccess: () => toast.success('Public name saved') },
                          )
                        }
                      >
                        Save name
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={`Move ${m.displayName} up`}
                      disabled={busy || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={`Move ${m.displayName} down`}
                      disabled={busy || index === ids.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={`Remove ${m.displayName}`}
                      disabled={busy}
                      onClick={() => actions.removeMonitor.mutate(m.monitorId)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {error && <Alert variant="error">{error.message}</Alert>}
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-56 flex-1 gap-2">
            <Label htmlFor="add-monitor">Add a monitor</Label>
            <Select
              id="add-monitor"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={monitors.isPending || available.length === 0}
            >
              <option value="">
                {monitors.isPending
                  ? 'Loading monitors…'
                  : available.length === 0
                    ? 'All your monitors are on this page'
                    : 'Choose a monitor'}
              </option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            disabled={
              !selected || busy || page.monitors.length >= STATUS_PAGE_LIMITS.monitorsPerPage
            }
            onClick={() =>
              actions.addMonitor.mutate(
                { monitorId: selected },
                { onSuccess: () => setSelected('') },
              )
            }
          >
            <Plus aria-hidden /> Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PublishCard({ page }: { page: StatusPage }) {
  const { setPublished } = useStatusPageActions(page.id);
  const url = publicUrl(page.slug);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Publication <PublishedBadge published={page.published} />
        </CardTitle>
        <CardDescription>
          {page.published
            ? `Public since ${formatDateTime(page.publishedAt!)}. Anyone with the link can see it, without signing in.`
            : 'Only you can see this page. Publish it to make the link work for everyone.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <code
            className="max-w-full truncate rounded bg-muted px-2 py-1 font-mono text-xs"
            data-testid="public-url"
          >
            {url}
          </code>
          <Button size="sm" variant="outline" onClick={() => copy(url)}>
            <Copy aria-hidden /> Copy link
          </Button>
          {page.published && (
            <Button size="sm" variant="outline" asChild>
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden /> Open
              </a>
            </Button>
          )}
          <Button size="sm" variant="outline" asChild>
            <Link to={`/app/status-pages/${page.id}/preview`}>
              <Eye aria-hidden /> Preview
            </Link>
          </Button>
        </div>
        {setPublished.isError && <Alert variant="error">{setPublished.error.message}</Alert>}
        <div>
          <Button
            variant={page.published ? 'outline' : 'default'}
            disabled={setPublished.isPending}
            onClick={() =>
              setPublished.mutate(!page.published, {
                onSuccess: (p) =>
                  toast.success(p.published ? 'Status page published' : 'Status page unpublished'),
              })
            }
          >
            {setPublished.isPending && <Spinner label="Saving" />}
            {page.published ? 'Unpublish' : 'Publish'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DeleteDialog({
  page,
  open,
  onOpenChange,
}: {
  page: StatusPage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { remove } = useStatusPageActions(page.id);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete “{page.title}”?</AlertDialogTitle>
        <AlertDialogDescription>
          The public link stops working immediately. Your monitors and their history are not
          affected.
        </AlertDialogDescription>
        {remove.isError && <Alert variant="error">{remove.error.message}</Alert>}
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  toast.success('Status page deleted');
                  void navigate('/app/status-pages', { replace: true });
                },
              })
            }
          >
            {remove.isPending && <Spinner label="Deleting" />}
            Delete page
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function NotFound() {
  return (
    <Card>
      <EmptyState
        icon={SearchX}
        title="Status page not found"
        action={
          <Button asChild variant="outline">
            <Link to="/app/status-pages">Back to status pages</Link>
          </Button>
        }
      >
        It may have been deleted, or the link is wrong.
      </EmptyState>
    </Card>
  );
}

export function StatusPageEditorPage() {
  const id = useParams().statusPageId ?? '';
  const query = useStatusPage(id);
  const [deleting, setDeleting] = useState(false);
  if (query.isPending) {
    return (
      <div className="grid gap-6" aria-busy>
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Status page" breadcrumbs={[crumbs, { label: 'Not available' }]} />
        {query.error instanceof ApiError && query.error.status === 404 ? (
          <NotFound />
        ) : (
          <ErrorState
            title="Couldn't load the status page"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )}
      </div>
    );
  }
  const page = query.data;
  return (
    <div className="grid gap-6">
      <PageHeader
        title={page.title}
        breadcrumbs={[crumbs, { label: page.title }]}
        description={<PublishedBadge published={page.published} />}
        actions={
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            <Trash2 aria-hidden /> Delete
          </Button>
        }
      />
      <PublishCard page={page} />
      <div className="grid gap-6 xl:grid-cols-2">
        <InfoCard key={page.updatedAt} page={page} />
        <MonitorsCard page={page} />
      </div>
      <DeleteDialog page={page} open={deleting} onOpenChange={setDeleting} />
    </div>
  );
}

export function StatusPagePreviewPage() {
  const id = useParams().statusPageId ?? '';
  const page = useStatusPage(id);
  const preview = useStatusPagePreview(id);
  if (preview.isPending || page.isPending) {
    return (
      <div className="grid gap-6" aria-busy>
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (preview.isError || page.isError) {
    const err = preview.error ?? page.error!;
    return err instanceof ApiError && err.status === 404 ? (
      <NotFound />
    ) : (
      <ErrorState
        title="Couldn't load the preview"
        error={err}
        onRetry={() => void preview.refetch()}
        retrying={preview.isFetching}
      />
    );
  }
  return (
    <div className="rounded-lg border border-border bg-background">
      <StatusPageView
        page={preview.data}
        banner={
          <Alert variant="info">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Preview of <strong>/status/{page.data.slug}</strong>.{' '}
                {page.data.published
                  ? 'This is what visitors see.'
                  : 'This page is a draft: visitors get “not found” until you publish it.'}
              </span>
              <Button size="sm" variant="outline" asChild>
                <Link to={`/app/status-pages/${id}`}>Back to editor</Link>
              </Button>
            </span>
          </Alert>
        }
      />
    </div>
  );
}
