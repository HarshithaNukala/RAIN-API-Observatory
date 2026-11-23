// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeMonitorApi } from '@/test-support/fake-monitor-api';
import { renderApp } from '@/test-support/render-app';

async function openTab(fake: ReturnType<typeof createFakeMonitorApi>, monitorId: string) {
  const view = renderApp(`/app/monitors/${monitorId}`, fake);
  await view.user.click(await view.findByRole('tab', { name: /notifications/i }));
  return view;
}

describe('monitor notification settings', () => {
  it('enables email for the account address', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Payments' });
    const { user } = await openTab(fake, m.id);
    const toggle = await screen.findByLabelText('Email 11111111@example.com about incidents');
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save notification settings' }));
    await waitFor(() => expect(fake.notificationSettings.get(m.id)?.emailEnabled).toBe(true));
    expect(fake.requests.find((r) => r.method === 'PUT')!.body).toEqual({ emailEnabled: true });
  });

  it('warns when the server has no email provider, and disables email without an address', async () => {
    const fake = createFakeMonitorApi();
    fake.emailProviderConfigured = false;
    fake.emailAddress = null;
    const m = fake.seed({ name: 'Payments' });
    await openTab(fake, m.id);
    expect(
      await screen.findByText(/Email delivery isn't configured on this RAIN server/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email me about incidents')).toBeDisabled();
  });

  it('adds a webhook with an auth header and shows the signing secret once', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Payments' });
    const { user } = await openTab(fake, m.id);
    expect(await screen.findByText(/never follows redirects/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.example.com/rain');
    await user.type(screen.getByLabelText('Header name'), 'Authorization');
    await user.type(screen.getByLabelText('Header value'), 'Bearer hook-token');
    await user.click(screen.getByRole('button', { name: 'Save notification settings' }));

    const secret = await screen.findByTestId('signing-secret');
    expect(secret.textContent).toMatch(/^whsec_/);
    expect(fake.notificationSettings.get(m.id)?.webhook).toMatchObject({
      url: 'https://hooks.example.com/rain',
      headerName: 'Authorization',
      headerValue: 'Bearer hook-token',
    });
    // The header value is never shown back; the name is.
    expect(await screen.findByText(/is configured\. Its value is/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Bearer hook-token');

    await user.click(screen.getByRole('button', { name: "I've stored it" }));
    expect(screen.queryByTestId('signing-secret')).not.toBeInTheDocument();
  });

  it('shows the server’s validation error for an unsafe webhook URL', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Payments' });
    const { user } = await openTab(fake, m.id);
    await user.type(await screen.findByLabelText('Endpoint URL'), 'http://169.254.169.254/latest');
    await user.click(screen.getByRole('button', { name: 'Save notification settings' }));
    expect(await screen.findByText(/private|not allowed|metadata|reserved/i)).toBeInTheDocument();
    expect(fake.notificationSettings.get(m.id)).toBeUndefined();
  });

  it('rotates the secret and removes the webhook', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Payments' });
    fake.notificationSettings.set(m.id, {
      emailEnabled: false,
      webhook: {
        enabled: true,
        url: 'https://hooks.example.com/rain',
        headerName: null,
        headerValue: null,
        updatedAt: '2026-11-19T09:00:00.000Z',
      },
    });
    const { user } = await openTab(fake, m.id);
    await user.click(await screen.findByRole('button', { name: 'Rotate signing secret' }));
    expect(await screen.findByTestId('signing-secret')).toBeInTheDocument();
    expect(fake.requests.find((r) => r.method === 'PUT')!.body).toMatchObject({
      webhook: { rotateSecret: true },
    });
    await user.click(screen.getByRole('button', { name: 'Remove webhook' }));
    await waitFor(() => expect(fake.notificationSettings.get(m.id)?.webhook).toBeNull());
    expect(await screen.findByLabelText('Endpoint URL')).toHaveValue('');
  });

  it('shows an error with retry when settings fail to load', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Payments' });
    fake.failNext('GET', /\/notifications$/, 'network-error');
    const { user } = await openTab(fake, m.id);
    expect(await screen.findByText("Couldn't load notification settings")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Endpoint URL')).toBeInTheDocument();
  });
});

function seedHistory() {
  const fake = createFakeMonitorApi();
  const m = fake.seed({ name: 'Payments' });
  const incident = fake.seedIncident(m.id);
  const ref = {
    monitor: { id: m.id, name: 'Payments' },
    incident: { id: incident.id, title: incident.title },
  };
  fake.seedDelivery({ ...ref });
  const failed = fake.seedDelivery({
    ...ref,
    channel: 'WEBHOOK',
    status: 'FAILED',
    destination: 'hooks.example.com',
    attempts: 8,
    deliveredAt: null,
    lastError: 'Webhook hooks.example.com answered HTTP 503 (gave up after 8 attempts)',
    attemptHistory: [
      {
        attemptNumber: 1,
        startedAt: '2026-11-19T09:00:00.000Z',
        finishedAt: '2026-11-19T09:00:01.000Z',
        outcome: 'TEMPORARY_FAILURE',
        httpStatus: 503,
        error: 'Webhook hooks.example.com answered HTTP 503',
      },
    ],
  });
  return { fake, m, failed };
}

describe('notification history', () => {
  it('lists deliveries with event, monitor, incident, channel, status, attempts and error', async () => {
    const { fake, failed } = seedHistory();
    renderApp('/app/notifications', fake);
    const table = await screen.findByRole('table', { name: 'Notification deliveries' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const failedRow = rows.find((r) => within(r).queryByText('Failed'))!;
    expect(within(failedRow).getByRole('link', { name: 'Incident opened' })).toHaveAttribute(
      'href',
      `/app/notifications/${failed.id}`,
    );
    expect(within(failedRow).getByText('hooks.example.com')).toBeInTheDocument();
    expect(within(failedRow).getByText('8 / 8')).toBeInTheDocument();
    expect(within(failedRow).getByText(/gave up after 8 attempts/)).toBeInTheDocument();
    expect(within(failedRow).getByRole('link', { name: 'Payments is down' })).toBeInTheDocument();
  });

  it('filters by status and channel through the API', async () => {
    const { fake } = seedHistory();
    const { user } = renderApp('/app/notifications', fake);
    await screen.findByRole('table', { name: 'Notification deliveries' });
    await user.selectOptions(screen.getByLabelText('Filter by delivery status'), 'FAILED');
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Notification deliveries' })).getAllByRole('row'),
      ).toHaveLength(2),
    );
    await user.selectOptions(screen.getByLabelText('Filter by channel'), 'EMAIL');
    expect(
      await screen.findByRole('heading', { name: 'No matching notifications' }),
    ).toBeInTheDocument();
    expect(
      fake.requests.some(
        (r) => r.path.includes('status=FAILED') && r.path.includes('channel=EMAIL'),
      ),
    ).toBe(true);
  });

  it('shows an empty state, and an error with retry', async () => {
    renderApp('/app/notifications', createFakeMonitorApi());
    expect(
      await screen.findByRole('heading', { name: 'No notifications yet' }),
    ).toBeInTheDocument();
  });

  it('recovers from a load error', async () => {
    const { fake } = seedHistory();
    fake.failNext('GET', /^\/api\/v1\/notifications$/, 'network-error');
    const { user } = renderApp('/app/notifications', fake);
    expect(await screen.findByText("Couldn't load notifications")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('table', { name: 'Notification deliveries' }),
    ).toBeInTheDocument();
  });

  it('shows a delivery’s attempts and retries a failed one', async () => {
    const { fake, failed } = seedHistory();
    const { user } = renderApp(`/app/notifications/${failed.id}`, fake);
    const attempts = await screen.findByRole('table', { name: 'Delivery attempts' });
    expect(within(attempts).getByText('Temporary failure')).toBeInTheDocument();
    expect(within(attempts).getByText('503')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry delivery' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry delivery' })).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/retry'))).toBe(true);
  });

  it('is in the main navigation', async () => {
    const { user } = renderApp('/app/monitors', createFakeMonitorApi());
    const nav = (await screen.findAllByRole('navigation', { name: 'Main' }))[0]!;
    await user.click(within(nav).getByRole('link', { name: 'Notifications' }));
    expect(
      await screen.findByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeInTheDocument();
  });
});
