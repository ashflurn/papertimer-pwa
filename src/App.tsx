import React, { useEffect, useMemo, useState } from "react";

/**
 * PaperTimer — Offline-friendly exam timer (MVP)
 *
 * Updates implemented:
 * 1) Top elapsed timer is truly real-time during the exam
 * 2) Colorful cue for unattended questions (never visited)
 * 3) Liberal warning on active question time vs. avg (2× = yellow, ~3× = light orange; no red)
 * 4) Reserve 5% of total time as 'Checking' and show it separately in UI
 * 5) BUGFIX: CSV export used an unterminated string; now uses "\n" correctly
 * 6) DEV TESTS: add lightweight tests for helpers and CSV export (opt-in via URL #runTests)
 * 7) NEW: Student name on setup; exam screen shows “Good luck, <name>! Ace this exam!” banner
 */

// ---------- Helpers ----------
const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
export const formatHMS = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const downloadText = (filename: string, text: string) => {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const splitAnsweringChecking = (totalSeconds: number) => {
  const answering = Math.floor(totalSeconds * 0.95);
  const checking = totalSeconds - answering;
  return { answering, checking };
};

export const avgPerQuestionFromAnswering = (answeringSeconds: number, numQuestions: number) => {
  return Math.ceil(answeringSeconds / Math.max(1, numQuestions));
};

export const buildGreeting = (name: string) => `Good luck${name ? ", " + name : ""}! Ace this exam!`;

// Robust newline constant to avoid accidental multi-line string issues in some editors
const EOL = String.fromCharCode(10);

// ---------- UI Atoms ----------
function Stat({ label, value, subtle }: { label: string; value: React.ReactNode; subtle?: boolean }) {
  return (
    <div className="flex flex-col items-start">
      <span className={`text-xs ${subtle ? "text-slate-500" : "text-slate-600"}`}>{label}</span>
      <span className="text-xl font-semibold tabular-nums text-slate-900">{value}</span>
    </div>
  );
}

function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "sky" | "amber" | "orange" | "emerald" | "violet" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700",
    sky: "bg-sky-100 text-sky-800",
    amber: "bg-amber-100 text-amber-800",
    orange: "bg-orange-100 text-orange-800",
    emerald: "bg-emerald-100 text-emerald-800",
    violet: "bg-violet-100 text-violet-800",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${tones[tone]}`}>{children}</span>;
}

function PrimaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`px-4 py-2 rounded-2xl shadow-sm bg-slate-900 text-white hover:bg-slate-800 active:scale-[0.99] transition ${
        (props.className as string) || ""
      }`}
    >
      {children}
    </button>
  );
}

function SoftButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`px-3 py-2 rounded-2xl bg-slate-100 text-slate-700 hover:bg-slate-200 active:scale-[0.99] transition ${
        (props.className as string) || ""
      }`}
    >
      {children}
    </button>
  );
}

// ---------- Main App ----------
export default function App() {
  const [phase, setPhase] = useState<"setup" | "countdown" | "exam" | "finished">("setup");
  const [numQuestions, setNumQuestions] = useState<number>(10);
  const [totalMinutes, setTotalMinutes] = useState<number>(90);
  const [studentName, setStudentName] = useState<string>("");

  const [countdown, setCountdown] = useState<number>(10);

  const [activeQ, setActiveQ] = useState<number | null>(null); // 1..N
  const [questionTotals, setQuestionTotals] = useState<number[]>([]); // seconds per question
  const [visited, setVisited] = useState<boolean[]>([]); // boolean per question

  const [examStartTs, setExamStartTs] = useState<number | null>(null); // epoch ms
  const [examEndTs, setExamEndTs] = useState<number | null>(null);
  const [lastTick, setLastTick] = useState<number | null>(null); // tick driver for real-time UI

  const totalSeconds = totalMinutes * 60;
  const { answering: answeringSeconds, checking: checkingSeconds } = splitAnsweringChecking(totalSeconds);

  // init arrays when numQuestions changes
  useEffect(() => {
    setQuestionTotals(Array.from({ length: numQuestions }, () => 0));
    setVisited(Array.from({ length: numQuestions }, () => false));
  }, [numQuestions]);

  // Countdown timer
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      const now = Date.now();
      setExamStartTs(now);
      setLastTick(now);
      setPhase("exam");
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  // Exam tick — update per-second for real-time UI + per-question accrual
  useEffect(() => {
    if (phase !== "exam") return;
    const handle = setInterval(() => {
      const now = Date.now();
      setQuestionTotals((prev) => prev.map((sec, i) => (activeQ === i + 1 ? sec + 1 : sec)));
      setLastTick(now); // forces re-render so elapsedSeconds refreshes in real-time

      if (examStartTs != null) {
        const elapsed = Math.floor((now - examStartTs) / 1000);
        if (elapsed >= totalSeconds) {
          finishExam();
        }
      }
    }, 1000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, activeQ, examStartTs, totalSeconds]);

  // Real-time elapsedSeconds — depend on lastTick so it updates every second
  const elapsedSeconds = useMemo(() => {
    if (!examStartTs) return 0;
    const base = phase === "exam" ? Date.now() : examEndTs || Date.now();
    return Math.min(totalSeconds, Math.max(0, Math.floor((base - examStartTs) / 1000)));
  }, [examStartTs, examEndTs, phase, totalSeconds, lastTick]);

  const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
  const inCheckingWindow = elapsedSeconds >= answeringSeconds; // last 5%
  const avgPerQuestion = avgPerQuestionFromAnswering(answeringSeconds, numQuestions);

  function onStart() {
    const n = Number(numQuestions);
    const m = Number(totalMinutes);
    if (!n || n < 1) return alert("Please enter a valid number of questions");
    if (!m || m < 1) return alert("Please enter a valid total time (minutes)");
    setCountdown(10);
    setPhase("countdown");
  }

  function switchToQuestion(q: number) {
    if (phase !== "exam") return;
    setActiveQ(q);
    setVisited((prev) => {
      const next = [...prev];
      next[q - 1] = true;
      return next;
    });
  }

  function finishExam() {
    if (phase !== "exam") return;
    setPhase("finished");
    setExamEndTs(Date.now());
    setActiveQ(null);
  }

  function resetAll() {
    setPhase("setup");
    setActiveQ(null);
    setExamStartTs(null);
    setExamEndTs(null);
    setLastTick(null);
    setQuestionTotals(Array.from({ length: numQuestions }, () => 0));
    setVisited(Array.from({ length: numQuestions }, () => false));
  }

  function exportCSV() {
    const rows = [["question_no", "total_seconds"], ...questionTotals.map((sec, i) => [i + 1, sec])];
    const csv = rows.map((r) => r.join(",")).join(EOL); // FIXED: proper newline string
    downloadText("paper-timer-results.csv", csv);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <header className="flex items-center justify-between py-2">
          <h1 className="text-2xl font-bold tracking-tight">PaperTimer</h1>
          <div className="flex items-center gap-2">
            {inCheckingWindow ? (
              <Pill tone="emerald">Checking time</Pill>
            ) : (
              <Pill tone="sky">Answering time</Pill>
            )}
            <span className="text-sm text-slate-500">Offline-friendly exam timing</span>
          </div>
        </header>

        <main className="mt-4">
          {phase === "setup" && (
            <SetupScreen
              numQuestions={numQuestions}
              setNumQuestions={setNumQuestions}
              totalMinutes={totalMinutes}
              setTotalMinutes={setTotalMinutes}
              studentName={studentName}
              setStudentName={setStudentName}
              onStart={onStart}
            />
          )}

          {phase === "countdown" && (
            <CountdownScreen countdown={countdown} totalMinutes={totalMinutes} numQuestions={numQuestions} />
          )}

          {phase === "exam" && (
            <ExamScreen
              numQuestions={numQuestions}
              activeQ={activeQ}
              switchToQuestion={switchToQuestion}
              questionTotals={questionTotals}
              visited={visited}
              elapsedSeconds={elapsedSeconds}
              remainingSeconds={remainingSeconds}
              totalSeconds={totalSeconds}
              answeringSeconds={answeringSeconds}
              checkingSeconds={checkingSeconds}
              avgPerQuestion={avgPerQuestion}
              inCheckingWindow={inCheckingWindow}
              studentName={studentName}
              onFinish={finishExam}
            />
          )}

          {phase === "finished" && (
            <FinishedScreen
              questionTotals={questionTotals}
              totalSeconds={totalSeconds}
              reset={resetAll}
              exportCSV={exportCSV}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ---------- Screens ----------
function SetupScreen({ numQuestions, setNumQuestions, totalMinutes, setTotalMinutes, studentName, setStudentName, onStart }: any) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-6 sm:p-8">
      <h2 className="text-xl font-semibold mb-1">Create Exam</h2>
      <p className="text-slate-600 mb-6">Configure the exam details and start when ready.</p>

      <div className="grid sm:grid-cols-2 gap-6">
        <div className="sm:col-span-2">
          <label className="block text-sm text-slate-600 mb-1">Student name (optional)</label>
          <input
            type="text"
            placeholder="e.g., Aanya R."
            value={studentName}
            onChange={(e) => setStudentName((e.target as HTMLInputElement).value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-600 mb-1">Number of questions</label>
          <input
            type="number"
            min={1}
            value={numQuestions}
            onChange={(e) => setNumQuestions(parseInt((e.target as HTMLInputElement).value || "0"))}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-600 mb-1">Total time (minutes)</label>
          <input
            type="number"
            min={1}
            value={totalMinutes}
            onChange={(e) => setTotalMinutes(parseInt((e.target as HTMLInputElement).value || "0"))}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
        </div>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <PrimaryButton onClick={onStart}>Start (10s countdown)</PrimaryButton>
        <span className="text-slate-500 text-sm">You can install this as an app later.</span>
      </div>
    </div>
  );
}

function CountdownScreen({ countdown, totalMinutes, numQuestions }: { countdown: number; totalMinutes: number; numQuestions: number }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-6 sm:p-10 flex flex-col items-center text-center">
      <p className="text-slate-600">Exam starting in</p>
      <div className="text-7xl font-black tabular-nums my-4">{pad(countdown)}</div>
      <div className="flex gap-6 mt-2">
        <Stat label="Questions" value={numQuestions} subtle />
        <Stat label="Total Time" value={`${totalMinutes} min`} subtle />
      </div>
      <div className="mt-6 w-full h-2 rounded-full bg-slate-100 overflow-hidden">
        <div
          className="h-full bg-slate-900 transition-all"
          style={{ width: `${((10 - countdown) / 10) * 100}%` }}
        />
      </div>
    </div>
  );
}

function ExamScreen({
  numQuestions,
  activeQ,
  switchToQuestion,
  questionTotals,
  visited,
  elapsedSeconds,
  remainingSeconds,
  totalSeconds,
  answeringSeconds,
  checkingSeconds,
  avgPerQuestion,
  inCheckingWindow,
  studentName,
  onFinish
}: any) {
  const progress = Math.min(100, (elapsedSeconds / totalSeconds) * 100);
  const answeringRemaining = Math.max(0, answeringSeconds - elapsedSeconds);
  const checkingRemaining = Math.max(0, checkingSeconds - Math.max(0, elapsedSeconds - answeringSeconds));

  const activeIdx = activeQ != null ? activeQ - 1 : null;
  const activeSec = activeIdx != null ? questionTotals[activeIdx] || 0 : 0;
  const activeRatio = avgPerQuestion > 0 ? activeSec / avgPerQuestion : 0;
  const warnLevel = activeRatio >= 2.8 ? "orange" : activeRatio >= 2 ? "amber" : null; // 2× → amber (yellow), ~3× → light orange

  const greeting = buildGreeting(studentName || "");

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="bg-white rounded-2xl shadow-sm p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex gap-6 items-center">
            <Stat label="Elapsed" value={formatHMS(elapsedSeconds)} />
            <Stat label="Remaining" value={formatHMS(remainingSeconds)} />
            <Stat label="Total" value={formatHMS(totalSeconds)} subtle />
            <div className="hidden sm:flex items-center gap-2">
              <Pill tone="sky">Answering: {formatHMS(answeringRemaining)}</Pill>
              <Pill tone="emerald">Checking: {formatHMS(checkingRemaining)}</Pill>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {warnLevel && activeQ && (
              <Pill tone={warnLevel as any}>
                Q{activeQ} {activeRatio >= 2.8 ? "≈ 3× avg" : "≥ 2× avg"}
              </Pill>
            )}
            <SoftButton onClick={onFinish}>Finish Exam</SoftButton>
          </div>
        </div>
        <div className="mt-4 w-full h-2 rounded-full bg-slate-100 overflow-hidden">
          <div className="h-full bg-slate-900 transition-all" style={{ width: `${progress}%` }} />
        </div>
        {/* Greeting banner */}
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-center">
          <div className="text-base sm:text-lg font-semibold text-slate-800">{greeting}</div>
        </div>
      </div>

      {/* Grid */}
      <div className="bg-white rounded-2xl shadow-sm p-4 sm:p-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          Questions
          <span className="text-xs text-slate-500 font-normal">Average per question: {formatHMS(avgPerQuestion)}</span>
        </h3>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 sm:gap-4">
          {Array.from({ length: numQuestions }).map((_, i) => {
            const q = i + 1;
            const isActive = activeQ === q;
            const neverVisited = !visited[i];
            const sec = questionTotals[i] || 0;
            // tile tones
            const baseIdle = neverVisited ? "border-sky-300 bg-sky-50" : "border-slate-200 bg-slate-50";
            const activeTone = warnLevel === "orange" && isActive
              ? "border-orange-300 bg-orange-200/20 text-orange-900"
              : warnLevel === "amber" && isActive
              ? "border-amber-300 bg-amber-100/30 text-amber-900"
              : "border-slate-900 bg-slate-900 text-white";

            return (
              <button
                key={q}
                onClick={() => switchToQuestion(q)}
                className={`group rounded-2xl border px-3 py-3 sm:px-4 sm:py-4 text-left transition shadow-sm ${
                  isActive ? activeTone : `${baseIdle} hover:bg-slate-100`
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-sm font-medium ${isActive ? "" : "text-slate-700"}`}>Q{q}</span>
                  {isActive ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/20">LIVE</span>
                  ) : neverVisited ? (
                    <Pill tone="sky">NEW</Pill>
                  ) : null}
                </div>
                <div className={`mt-2 text-lg sm:text-xl font-semibold tabular-nums ${isActive ? "" : "text-slate-900"}`}>
                  {formatHMS(sec)}
                </div>
                {!isActive && neverVisited && (
                  <div className="mt-1 text-[10px] text-sky-800">Unattended</div>
                )}
                {isActive && (warnLevel === "amber" || warnLevel === "orange") && (
                  <div className="mt-1 text-xs">
                    <span className={warnLevel === "orange" ? "text-orange-800" : "text-amber-800"}>
                      Spending long on this question
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FinishedScreen({ questionTotals, totalSeconds, reset, exportCSV }: any) {
  const totalSpent = questionTotals.reduce((a: number, b: number) => a + b, 0);
  return (
    <div className="bg-white rounded-2xl shadow-sm p-6">
      <h2 className="text-xl font-semibold mb-1">Exam Finished</h2>
      <p className="text-slate-600 mb-4">Review per-question timing and export results.</p>

      <div className="flex gap-6 mb-6">
        <Stat label="Total Measured" value={formatHMS(totalSpent)} />
        <Stat label="Configured Total" value={formatHMS(totalSeconds)} subtle />
      </div>

      <div className="overflow-auto rounded-xl border border-slate-200">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-slate-600">
              <th className="px-3 py-2 text-left font-medium">Question</th>
              <th className="px-3 py-2 text-left font-medium">Time</th>
              <th className="px-3 py-2 text-left font-medium">Seconds</th>
            </tr>
          </thead>
          <tbody>
            {questionTotals.map((sec: number, i: number) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-3 py-2">Q{i + 1}</td>
                <td className="px-3 py-2 tabular-nums">{formatHMS(sec)}</td>
                <td className="px-3 py-2 tabular-nums">{sec}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <PrimaryButton onClick={exportCSV}>Export CSV</PrimaryButton>
        <SoftButton onClick={reset}>Create New Exam</SoftButton>
      </div>
    </div>
  );
}

// ---------- DEV TESTS (opt-in) ----------
// Run by appending #runTests to the URL (e.g., http://localhost:5173/#runTests)
function runDevTests() {
  try {
    let passed = 0;
    let failed = 0;
    const results: string[] = [];

    const assertEqual = (name: string, actual: any, expected: any) => {
      if (actual === expected) {
        passed++;
        results.push(`✔︎ ${name}`);
      } else {
        failed++;
        results.push(`✘ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    };

    // formatHMS tests
    assertEqual("formatHMS(0)", formatHMS(0), "0:00");
    assertEqual("formatHMS(59)", formatHMS(59), "0:59");
    assertEqual("formatHMS(60)", formatHMS(60), "1:00");
    assertEqual("formatHMS(3599)", formatHMS(3599), "59:59");
    assertEqual("formatHMS(3600)", formatHMS(3600), "1:00:00");
    assertEqual("formatHMS(-5)", formatHMS(-5), "0:00");

    // time split and avg tests
    const { answering, checking } = splitAnsweringChecking(6000); // 100 min
    assertEqual("splitAnsweringChecking answering", answering, 5700);
    assertEqual("splitAnsweringChecking checking", checking, 300);
    assertEqual("avgPerQuestion 5700/57", avgPerQuestionFromAnswering(5700, 57), 100);
    const edgeSmall = splitAnsweringChecking(59);
    assertEqual("splitAnsweringChecking(59).answering", edgeSmall.answering, 56);
    assertEqual("splitAnsweringChecking(59).checking", edgeSmall.checking, 3);
    assertEqual("avgPerQuestion 0/10", avgPerQuestionFromAnswering(0, 10), 0);
    assertEqual("avgPerQuestion ceil(95/10)", avgPerQuestionFromAnswering(95, 10), 10);

    // CSV newline test
    const rows = [["question_no", "total_seconds"], [1, 12], [2, 34]];
    const csv = rows.map((r) => r.join(",")).join(EOL);
    assertEqual("CSV has 3 lines", csv.split(EOL).length, 3);

    // greeting tests
    assertEqual("greeting empty name", buildGreeting(""), "Good luck! Ace this exam!");
    assertEqual("greeting with name", buildGreeting("Aanya"), "Good luck, Aanya! Ace this exam!");

    console.groupCollapsed(`PaperTimer tests: ${passed} passed, ${failed} failed`);
    results.forEach((r) => (r.startsWith("✔︎") ? console.log(r) : console.warn(r)));
    console.groupEnd();
  } catch (e) {
    console.error("PaperTimer tests crashed:", e);
  }
}

if (typeof window !== "undefined" && window.location && window.location.hash.includes("runTests")) {
  runDevTests();
}
