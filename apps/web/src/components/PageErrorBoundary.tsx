import { Component, type ReactNode } from "react";

// Any page that fails to load or render shows a way out, never a blank screen.
export default class PageErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error) {
    console.error("[page]", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const isUpdate = /dynamically imported module|Importing a module script failed|Failed to fetch|ChunkLoad/i.test(this.state.error.message);
    return (
      <div className="max-w-md mx-auto mt-16 text-center bg-white border border-slate-200 rounded-2xl p-8 animate-fade-in">
        <div className="text-lg font-semibold text-slate-900">{isUpdate ? "A new version is available" : "This page hit a problem"}</div>
        <p className="text-sm text-slate-500 mt-2">
          {isUpdate ? "Vahlay was just updated. Reload to continue — nothing you saved is lost." : "Reload the page to try again. If it keeps happening, let your admin know."}
        </p>
        <button onClick={() => window.location.reload()} className="mt-5 bg-red-600 text-white text-sm font-medium rounded-lg px-5 py-2 hover:bg-red-700">
          Reload
        </button>
      </div>
    );
  }
}
