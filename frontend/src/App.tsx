import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom'
import { ApiRegistryPage } from './pages/ApiRegistryPage'
import { AddApiPage } from './pages/AddApiPage'
import { ApiDetailsPage } from './pages/ApiDetailsPage'
import { DashboardPage } from './pages/DashboardPage'

function App() {
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
            <Route path="/" element={<DashboardPage />} />
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
