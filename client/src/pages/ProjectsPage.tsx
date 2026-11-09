import { useState, useEffect } from 'react'
import { Plus, Share2, Users, ExternalLink, Trash2, Check, FolderKanban } from 'lucide-react'
import type { Project, Subcontractor } from '../types'
import { apiProjects, apiSubcontractors } from '../api'
import { ProjectModal } from '../components/ProjectModal'
import { ShareModal } from '../components/ShareModal'
import { ComplianceScore } from '../components/ComplianceScore'

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [subs, setSubs] = useState<Subcontractor[]>([])
  const [loading, setLoading] = useState(true)
  const [projectModal, setProjectModal] = useState(false)
  const [editProject, setEditProject] = useState<Project | null>(null)
  const [shareProject, setShareProject] = useState<Project | null>(null)
  const [assignProject, setAssignProject] = useState<Project | null>(null)
  const [selectedSubId, setSelectedSubId] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 3000)
  }

  const load = async () => {
    try {
      const [p, s] = await Promise.all([apiProjects.list(), apiSubcontractors.list()])
      setProjects(p.projects)
      setSubs(s.subcontractors)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const handleDelete = async (p: Project) => {
    if (!confirm(`Delete project "${p.name}"?`)) return
    await apiProjects.delete(p.id)
    showToast('Project deleted')
    load()
  }

  const handleAssign = async () => {
    if (!assignProject || !selectedSubId) return
    await apiProjects.assignSub(assignProject.id, selectedSubId)
    showToast('Subcontractor assigned to project')
    setSelectedSubId('')
    load()
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-40 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-400" /> {toast}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900">Projects & Client Sharing</h1>
          <p className="text-xs text-slate-500 mt-1">
            Group subcontractors by job and generate privacy-safe client compliance links in one click.
          </p>
        </div>
        <button
          onClick={() => { setEditProject(null); setProjectModal(true) }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm self-start sm:self-auto"
        >
          <Plus className="w-3.5 h-3.5" /> New project
        </button>
      </div>

      {loading ? (
        <p className="text-center text-xs text-slate-400 py-12">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="text-center text-xs text-slate-400 italic py-12">No projects yet. Create your first project.</p>
      ) : (
        <div className="space-y-6">
          {projects.map((p) => {
            const sc = p.scorecard || { score: 100, compliant: 0, expiring: 0, expired: 0, missing: 0, pending: 0, total: 0 }
            return (
              <div key={p.id} className="bg-white rounded-3xl p-6 sm:p-7 border border-slate-200 shadow-card space-y-5">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-['JetBrains_Mono'] text-slate-400 font-bold">
                      <FolderKanban className="w-4 h-4 text-brand-600" /> {p.code || 'NO CODE'}
                    </div>
                    <h2 className="text-2xl font-extrabold text-slate-900 mt-1">{p.name}</h2>
                    <p className="text-xs text-slate-500 mt-1">
                      {[p.address, p.client_name && `Client: ${p.client_name}`].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => setShareProject(p)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition shadow-sm"
                    >
                      <Share2 className="w-3.5 h-3.5" /> Create client share link
                    </button>
                    <button
                      onClick={() => { setEditProject(p); setProjectModal(true) }}
                      className="px-3 py-2 rounded-xl text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="p-2 rounded-xl text-rose-500 hover:bg-rose-50"
                      title="Delete project"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                  <div className="md:col-span-2">
                    <ComplianceScore
                      scorecard={sc}
                      title={`${p.name} compliance`}
                      subtitle={`${p.sub_count || 0} subcontractors assigned to this job`}
                    />
                  </div>
                  <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs space-y-2">
                    <div className="font-bold text-slate-700">Client sharing status</div>
                    <div className="text-slate-500">
                      {p.share_count ? `${p.share_count} active client link(s)` : 'No share link created yet'}
                    </div>
                    <button
                      onClick={() => setShareProject(p)}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-brand-700 bg-white border border-brand-200 hover:bg-brand-50"
                    >
                      <Share2 className="w-3 h-3" /> Get share link
                    </button>
                  </div>
                </div>

                {p.notes && <p className="text-xs text-slate-600 italic">{p.notes}</p>}

                {/* Subcontractor assignment section */}
                <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <span className="text-slate-500">
                    {p.sub_count || 0} subcontractors assigned · add or remove anytime
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedSubId}
                      onChange={(e) => setSelectedSubId(e.target.value)}
                      className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      <option value="">Select a subcontractor to add…</option>
                      {subs.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.company_name} ({s.trade})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => { setAssignProject(p); setTimeout(handleAssign, 0) }}
                      disabled={!selectedSubId}
                      className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50"
                    >
                      Assign
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ProjectModal
        open={projectModal}
        onClose={() => setProjectModal(false)}
        project={editProject}
        onSaved={() => { showToast('Project saved'); load() }}
      />
      <ShareModal
        project={shareProject}
        open={Boolean(shareProject)}
        onClose={() => setShareProject(null)}
        onCreated={() => { showToast('Client link generated'); load() }}
      />
    </div>
  )
}
