import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { LatencySeriesPoint } from '../types/metrics';

interface LatencyChartProps {
  data: LatencySeriesPoint[];
}

export const LatencyChart = ({ data }: LatencyChartProps) => {
  if (!data || data.length === 0) {
    return <div className="h-64 flex items-center justify-center text-slate-400">No latency data available.</div>;
  }

  const formatTime = (timeStr: string) => {
    const date = new Date(timeStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis 
            dataKey="timestamp" 
            tickFormatter={formatTime} 
            stroke="#94a3b8" 
            fontSize={12} 
            tickMargin={10} 
            minTickGap={30}
          />
          <YAxis 
            stroke="#94a3b8" 
            fontSize={12} 
            tickFormatter={(val) => `${val}ms`}
            width={60}
          />
          <Tooltip 
            labelFormatter={(label) => new Date(label as string | number).toLocaleString()}
            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
          />
          <Line 
            type="monotone" 
            dataKey="p95ResponseLatencyMs" 
            name="P95 Latency" 
            stroke="#f59e0b" 
            strokeWidth={2}
            dot={false}
          />
          <Line 
            type="monotone" 
            dataKey="averageResponseLatencyMs" 
            name="Avg Latency" 
            stroke="#4f46e5" 
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
