import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import type { SuccessFailureSeriesPoint } from '../types/metrics';

interface SuccessFailureChartProps {
  data: SuccessFailureSeriesPoint[];
}

export const SuccessFailureChart = ({ data }: SuccessFailureChartProps) => {
  if (!data || data.length === 0) {
    return <div className="h-64 flex items-center justify-center text-slate-400">No status data available.</div>;
  }

  const formatTime = (timeStr: string) => {
    const date = new Date(timeStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis 
            dataKey="timestamp" 
            tickFormatter={formatTime} 
            stroke="#94a3b8" 
            fontSize={12} 
            tickMargin={10}
            minTickGap={30}
          />
          <YAxis stroke="#94a3b8" fontSize={12} width={40} />
          <Tooltip 
            labelFormatter={(label) => new Date(label as string | number).toLocaleString()}
            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
            cursor={{ fill: '#f8fafc' }}
          />
          <Legend wrapperStyle={{ paddingTop: '20px' }} />
          <Bar dataKey="successful" name="Successful" stackId="a" fill="#10b981" radius={[0, 0, 4, 4]} />
          <Bar dataKey="failed" name="Failed" stackId="a" fill="#ef4444" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
