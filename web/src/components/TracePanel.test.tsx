import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TracePanel } from './TracePanel.js';

describe('TracePanel', () => {
  it('keeps newest events at the bottom, renders unknown types, and clears', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <TracePanel
        events={[
          { ts: '2026-11-07T00:00:00.000Z', type: 'tool_call', summary: 'first' },
          {
            ts: '2026-11-07T00:00:01.000Z',
            type: 'widget',
            summary: 'second',
            detail: { a: 1 },
          },
        ]}
        onClear={onClear}
      />,
    );

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('first');
    expect(items[1]).toHaveTextContent('second');
    expect(screen.getByText('widget')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show detail/i }));
    expect(screen.getByRole('list', { name: /trace events/i })).toHaveTextContent('"a": 1');

    await user.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});