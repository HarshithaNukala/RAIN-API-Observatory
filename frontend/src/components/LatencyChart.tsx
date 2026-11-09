import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot } from 'recharts';
import type { LatencySeriesPoint } from '../types/metrics';
import type { Anomaly } from '../types/intelligence';

interface LatencyChartProps {
  data: LatencySeriesPoint[];
  anomalies?: Anomaly[];
}

const formatTime = (timeStr: string) => {
  const date = new Date(timeStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  label?: string;
  anomalies?: Anomaly[];
}

const CustomTooltip = ({ active, payload, label, anomalies = [] }: CustomTooltipProps) => {
  if (active && payload && payload.length && label) {
    const pointTime = label;
    const anomaly = anomalies.find((a: Anomaly) => new Date(a.checkedAt).getTime() === new Date(pointTime).getTime());
    
    return (
      <div className="bg-white p-3 border border-slate-200 rounded-lg shadow-md text-sm">
        <p className="font-semibold text-slate-700 mb-2">{new Date(pointTime).toLocaleString()}</p>
        {payload.map((entry, index) => (
          <p key={index} style={{ color: entry.color }} className="flex justify-between w-32">
            <span>{entry.name}:</span>
            <span className="font-medium">{entry.value}ms</span>
          </p>
        ))}
        {anomaly && (
          <div className="mt-2 pt-2 border-t border-slate-100">
            <p className="text-red-600 font-semibold flex items-center">
              <span className="w-2 h-2 rounded-full bg-red-500 mr-2"></span>
              Anomaly Detected
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Baseline Avg: {Math.round(anomaly.baselineAvgMs)}ms
              <br />
              Baseline StdDev: {Math.round(anomaly.baselineStdDevMs)}ms
            </p>
          </div>
        )}
      </div>
    );
  }
  return null;
};

export const LatencyChart = ({ data, anomalies = [] }: LatencyChartProps) => {
  if (!data || data.length === 0) {
    return <div className="h-64 flex items-center justify-center text-slate-400">No latency data available.</div>;
  }

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
          <Tooltip content={<CustomTooltip anomalies={anomalies} />} />
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
          {anomalies.map((anomaly, idx) => (
            <ReferenceDot 
              key={idx} 
              x={new Date(anomaly.checkedAt).toISOString()} 
              y={anomaly.latencyMs} 
              r={4} 
              fill="red" 
              stroke="white" 
              strokeWidth={2} 
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
