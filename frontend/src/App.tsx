import { useHealth } from './services/api'

function App() {
  const { data: health, isLoading, isError } = useHealth()

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold text-rain-dark tracking-tight mb-4">
          RAIN
        </h1>
        <h2 className="text-2xl text-slate-600 mb-2">API Reliability Observatory</h2>
        <p className="text-lg text-rain-purple font-medium">
          "Know your APIs before your users do."
        </p>
      </div>

      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 border border-slate-100">
        <h3 className="text-lg font-semibold text-slate-800 mb-6 flex items-center justify-between">
          <span>RAIN SYSTEM</span>
          <span className="text-xs px-2 py-1 bg-slate-100 text-slate-500 rounded-full">Foundation</span>
        </h3>
        
        <div className="space-y-4">
          <div className="flex justify-between items-center p-4 bg-slate-50 rounded-lg">
            <span className="text-sm text-slate-600 font-medium">Backend Status</span>
            
            <div className="flex items-center space-x-2">
              {isLoading ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div>
                  <span className="text-sm font-semibold text-amber-600">Checking...</span>
                </>
              ) : isError ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-red-500"></div>
                  <span className="text-sm font-semibold text-red-600">Unavailable</span>
                </>
              ) : (
                <>
                  <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                  <span className="text-sm font-semibold text-emerald-600">Connected</span>
                </>
              )}
            </div>
          </div>

          {health && (
            <div className="text-xs text-slate-400 text-center mt-4">
              Last check: {new Date(health.timestamp).toLocaleTimeString()}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
