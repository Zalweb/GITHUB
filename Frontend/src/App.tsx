import { useMemo, useState } from "react";
import RegisterTab from "./components/RegisterTab";
import RecognizeTab from "./components/RecognizeTab";
import AdminTab from "./components/AdminTab";
import AttendanceTab from "./components/AttendanceTab";
import { getApiBaseUrl } from "./services/api";

type TabKey = "register" | "recognize" | "checkin" | "admin";

export default function App() {
  const [active, setActive] = useState<TabKey>("register");
  const baseUrl = useMemo(() => getApiBaseUrl(), []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-bg0 via-bg1 to-slate-950 px-3 pb-10 pt-4 text-slate-100">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <header className="rounded-2xl border border-white/15 bg-white/5 p-4 shadow-soft">
          <h1 className="text-2xl font-bold tracking-tight">Face Camera Tester</h1>
          <p className="mt-1 text-sm text-slate-300">Backend: {baseUrl}</p>
          <p className="text-xs text-slate-400">Video preview is mirrored.</p>
        </header>

        <nav className="grid grid-cols-4 gap-2 rounded-2xl border border-white/15 bg-white/5 p-2">
          <button
            type="button"
            onClick={() => setActive("register")}
            className={`rounded-lg px-3 py-2 text-sm ${active === "register" ? "bg-cyan-500 text-slate-950" : "bg-black/20 text-slate-100"}`}
          >
            Register
          </button>
          <button
            type="button"
            onClick={() => setActive("recognize")}
            className={`rounded-lg px-3 py-2 text-sm ${active === "recognize" ? "bg-cyan-500 text-slate-950" : "bg-black/20 text-slate-100"}`}
          >
            Recognize
          </button>
          <button
            type="button"
            onClick={() => setActive("checkin")}
            className={`rounded-lg px-3 py-2 text-sm ${active === "checkin" ? "bg-cyan-500 text-slate-950" : "bg-black/20 text-slate-100"}`}
          >
            Check-in
          </button>
          <button
            type="button"
            onClick={() => setActive("admin")}
            className={`rounded-lg px-3 py-2 text-sm ${active === "admin" ? "bg-cyan-500 text-slate-950" : "bg-black/20 text-slate-100"}`}
          >
            Admin
          </button>
        </nav>

        {active === "register" ? <RegisterTab /> : null}
        {active === "recognize" ? <RecognizeTab /> : null}
        {active === "checkin" ? <AttendanceTab /> : null}
        {active === "admin" ? <AdminTab /> : null}
      </div>
    </div>
  );
}
