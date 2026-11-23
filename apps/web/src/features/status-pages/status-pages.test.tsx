// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeMonitorApi } from '@/test-support/fake-monitor-api';
import { renderApp } from '@/test-support/render-app';

function seedPublished() {
  const fake = createFakeMonitorApi();
  const api = fake.seed({
    name: 'payments-prod (internal)',
    currentStatus: 'DOWN',
    url: 'https://internal.example.com/x?key=secret',
    lastCheckedAt: '2026-11-19T10:25:00.000Z',
  });
  const web = fake.seed({ name: 'web-internal', currentStatus: 'HEALTHY' });
  const batch = fake.seed({ name: 'batch-internal', currentStatus: 'DOWN', enabled: false });
  fake.seedIncident(api.id, {
    title: 'payments-prod (internal) is down',
    description: 'connection refused 10.0.0.7',
  });
  const page = fake.seedStatusPage({
    title: 'Acme status',
    description: 'Live status of Acme services.\n<script>alert(1)</script>',
    slug: 'acme',
    published: true,
    publishedAt: '2026-11-19T09:00:00.000Z',
    monitors: [
      {
        monitorId: api.id,
        monitorName: '',
        displayName: 'Payments API',
        position: 0,
        currentStatus: 'DOWN',
        enabled: true,
      },
      {
        monitorId: web.id,
        monitorName: '',
        displayName: 'Website',
        position: 1,
        currentStatus: 'HEALTHY',
        enabled: true,
      },
      {
        monitorId: batch.id,
        monitorName: '',
        displayName: 'Batch jobs',
        position: 2,
        currentStatus: 'DOWN',
        enabled: false,
      },
    ],
  });
  return { fake, page, api, web, batch };
}

describe('public status page', () => {
  it('renders for a signed-out visitor: overall status, services, paused service and incidents', async () => {
    const { fake } = seedPublished();
    renderApp('/status/acme', fake, { signedIn: false });

    expect(
      await screen.findByRole('heading', { name: 'Acme status', level: 1 }),
    ).toBeInTheDocument();
    // Plain text: the "script" is shown as text, never executed or parsed as HTML.
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Overall status' })).getByText(
        'Service disruption',
      ),
    ).toBeInTheDocument();

    const services = screen.getAllByTestId('public-service');
    expect(services.map((s) => within(s).getAllByText(/./)[0]!.textContent)).toEqual([
      'Payments API',
      'Website',
      'Batch jobs',
    ]);
    expect(within(services[0]!).getByText('Down')).toBeInTheDocument();
    expect(within(services[0]!).getByText(/Last checked/)).toBeInTheDocument();
    expect(within(services[1]!).getByText('Operational')).toBeInTheDocument();
    expect(within(services[2]!).getByText('Paused')).toBeInTheDocument();
    expect(
      within(services[2]!).getByText(/not included in the overall status/),
    ).toBeInTheDocument();
    // No data is shown as "No data", never as 100% or 0%.
    expect(within(services[1]!).getByText('No data available')).toBeInTheDocument();

    const incidents = screen.getByRole('list', { name: 'Incident history' });
    expect(within(incidents).getByText('Payments API disruption')).toBeInTheDocument();
    expect(within(incidents).getByText('Investigating')).toBeInTheDocument();
    expect(screen.getByText(/Last updated/)).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    for (const leak of ['internal', 'secret', '10.0.0.7', 'connection refused'])
      expect(text).not.toContain(leak);
    // No sign-in redirect, no app navigation.
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('shows "not found" for unpublished or unknown pages', async () => {
    const { fake, page } = seedPublished();
    page.published = false;
    fake.statusPages[0]!.published = false;
    renderApp('/status/acme', fake, { signedIn: false });
    expect(
      await screen.findByRole('heading', { name: 'Status page not found' }),
    ).toBeInTheDocument();
  });

  it('offers a retry when the page fails to load', async () => {
    const { fake } = seedPublished();
    fake.failNext('GET', /\/public\/status-pages\//, 'network-error');
    const { user } = renderApp('/status/acme', fake, { signedIn: false });
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Acme status', level: 1 }),
    ).toBeInTheDocument();
  });

  it('management pages still require sign-in', async () => {
    const { router } = renderApp('/app/status-pages', createFakeMonitorApi(), { signedIn: false });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('status page management', () => {
  it('shows an empty state and creates a draft page that opens in the editor', async () => {
    const fake = createFakeMonitorApi();
    const { user, router } = renderApp('/app/status-pages', fake);
    expect(await screen.findByRole('heading', { name: 'No status pages yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create a status page' }));
    await user.type(screen.getByLabelText('Title'), 'Acme status');
    await user.type(screen.getByLabelText('Public address (optional)'), 'acme');
    await user.click(screen.getByRole('button', { name: 'Create page' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/app\/status-pages\/.+/));
    expect(await screen.findByText(/Only you can see this page/)).toBeInTheDocument();
    expect(screen.getByTestId('public-url').textContent).toMatch(/\/status\/acme$/);
  });

  it('shows the server’s slug error', async () => {
    const fake = createFakeMonitorApi();
    fake.seedStatusPage({ title: 'Taken', slug: 'acme' });
    const { user } = renderApp('/app/status-pages', fake);
    await user.click(await screen.findByRole('button', { name: 'New status page' }));
    await user.type(screen.getByLabelText('Title'), 'Mine');
    await user.type(screen.getByLabelText('Public address (optional)'), 'acme');
    await user.click(screen.getByRole('button', { name: 'Create page' }));
    expect(await screen.findByText('This address is already in use')).toBeInTheDocument();
  });

  it('lists pages with their state', async () => {
    const { fake } = seedPublished();
    fake.seedStatusPage({ title: 'Draft page', slug: 'draft' });
    renderApp('/app/status-pages', fake);
    const list = await screen.findByRole('list', { name: 'Status pages' });
    expect(within(list).getByText('Acme status').closest('li')!).toHaveTextContent(
      '3 servicesPublished',
    );
    expect(within(list).getByText('Draft page').closest('li')!).toHaveTextContent(
      '0 servicesDraft',
    );
  });

  it('adds, renames, reorders and removes monitors', async () => {
    const fake = createFakeMonitorApi();
    const a = fake.seed({ name: 'Alpha' });
    const b = fake.seed({ name: 'Beta' });
    const page = fake.seedStatusPage({ title: 'Acme', slug: 'acme' });
    const { user } = renderApp(`/app/status-pages/${page.id}`, fake);

    const select = await screen.findByLabelText('Add a monitor');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    await user.selectOptions(select, a.id);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.selectOptions(await screen.findByLabelText('Add a monitor'), b.id);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const services = await screen.findByRole('list', { name: 'Services on this page' });
    await waitFor(() => expect(within(services).getAllByRole('listitem')).toHaveLength(2));

    const name = screen.getByLabelText('Public name for Alpha');
    await user.clear(name);
    await user.type(name, 'Payments API');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(fake.statusPages[0]!.monitors[0]!.displayName).toBe('Payments API'));

    await user.click(screen.getByRole('button', { name: 'Move Payments API down' }));
    await waitFor(() =>
      expect(fake.statusPages[0]!.monitors.map((m) => m.monitorId)).toEqual([b.id, a.id]),
    );
    expect(fake.requests.find((r) => r.method === 'PUT')!.body).toEqual({
      monitorIds: [b.id, a.id],
    });

    await user.click(screen.getByRole('button', { name: 'Remove Beta' }));
    await waitFor(() =>
      expect(fake.statusPages[0]!.monitors.map((m) => m.monitorId)).toEqual([a.id]),
    );
  });

  it('publishes, copies the link, unpublishes and deletes', async () => {
    const fake = createFakeMonitorApi();
    const page = fake.seedStatusPage({ title: 'Acme', slug: 'acme' });
    const { user, router } = renderApp(`/app/status-pages/${page.id}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/Anyone with the link can see it/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/status\/acme$/),
    );
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await user.click(screen.getByRole('button', { name: 'Unpublish' }));
    expect(await screen.findByText(/Only you can see this page/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete page' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/status-pages'));
    expect(fake.statusPages).toHaveLength(0);
  });

  it('previews a draft exactly as visitors would see it', async () => {
    const { fake, page } = seedPublished();
    fake.statusPages[0]!.published = false;
    renderApp(`/app/status-pages/${page.id}/preview`, fake);
    expect(await screen.findByText(/This page is a draft/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Acme status', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByTestId('public-service')).toHaveLength(3);
  });

  it('shows an error with retry when the list fails, and is in the navigation', async () => {
    const fake = createFakeMonitorApi();
    fake.failNext('GET', /^\/api\/v1\/status-pages$/, 'network-error');
    const { user } = renderApp('/app/status-pages', fake);
    expect(await screen.findByText("Couldn't load status pages")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No status pages yet' })).toBeInTheDocument();
    const nav = screen.getAllByRole('navigation', { name: 'Main' })[0]!;
    expect(within(nav).getByRole('link', { name: 'Status pages' })).toHaveAttribute(
      'href',
      '/app/status-pages',
    );
  });
});
