import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom'
import { ApiRegistryPage } from './pages/ApiRegistryPage'
import { AddApiPage } from './pages/AddApiPage'
import { ApiDetailsPage } from './pages/ApiDetailsPage'
import { useHealth } from './services/api'

function App() {
  const { isLoading, isError } = useHealth()

  return (
    <Router>
      <div className="min-h-screen flex flex-col bg-slate-50">
        <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-8 h-16 flex items-center justify-between">
            <Link to="/" className="flex items-center space-x-2">
              <span className="text-2xl font-bold text-indigo-600 tracking-tight">RAIN</span>
              <span className="text-sm font-medium text-slate-500 hidden sm:inline-block">API Reliability Observatory</span>
            </Link>
            <nav className="flex space-x-6 text-sm font-medium">
              <Link to="/" className="text-slate-600 hover:text-indigo-600 transition">Dashboard</Link>
              <Link to="/apis" className="text-slate-600 hover:text-indigo-600 transition">API Registry</Link>
            </nav>
          </div>
        </header>
        
        <main className="flex-1">
          <Routes>
            <Route path="/" element={
              <div className="flex flex-col items-center justify-center p-8 mt-12">
                <div className="text-center mb-12">
                  <h1 className="text-5xl font-bold text-slate-800 tracking-tight mb-4">RAIN</h1>
                  <h2 className="text-2xl text-slate-600 mb-2">API Reliability Observatory</h2>
                  <p className="text-lg text-indigo-500 font-medium">"Know your APIs before your users do."</p>
                </div>
                <div className="w-full max-w-md bg-white rounded-2xl shadow-sm p-8 border border-slate-200">
                  <h3 className="text-lg font-semibold text-slate-800 mb-6 flex items-center justify-between">
                    <span>RAIN SYSTEM</span>
                    <span className="text-xs px-2 py-1 bg-slate-100 text-slate-500 rounded-full">Foundation</span>
                  </h3>
                  <div className="space-y-4">
                    <div className="flex justify-between items-center p-4 bg-slate-50 rounded-lg border border-slate-100">
                      <span className="text-sm text-slate-600 font-medium">Backend Status</span>
                      <div className="flex items-center space-x-2">
                        {isLoading ? (
                          <><div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div><span className="text-sm font-semibold text-amber-600">Checking...</span></>
                        ) : isError ? (
                          <><div className="w-2 h-2 rounded-full bg-red-500"></div><span className="text-sm font-semibold text-red-600">Unavailable</span></>
                        ) : (
                          <><div className="w-2 h-2 rounded-full bg-emerald-500"></div><span className="text-sm font-semibold text-emerald-600">Connected</span></>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            } />
            <Route path="/apis" element={<ApiRegistryPage />} />
            <Route path="/apis/new" element={<AddApiPage />} />
            <Route path="/apis/:id" element={<ApiDetailsPage />} />
          </Routes>
        </main>
      </div>
    </Router>
  )
}

export default App
