/**
 * HelpModal — "How it works & coaching tips". Plain-English walkthrough of every card + metric,
 * some study-coaching guidance, and a privacy note. Static content, rendered in the shared `Modal`.
 */

import { Info, Gauge, Sparkles, Shield, Flame, TrendingUp, CalendarDays } from "lucide-react";
import Modal from "../ui/Modal";

interface Props {
  open: boolean;
  onClose: () => void;
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Info;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-content-primary">
        <Icon size={15} strokeWidth={2.25} className="text-lime" aria-hidden />
        {title}
      </h3>
      <div className="space-y-1.5 text-[0.82rem] leading-relaxed text-content-secondary">{children}</div>
    </section>
  );
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p>
      <span className="font-medium text-content-primary">{label}</span> — {children}
    </p>
  );
}

export default function HelpModal({ open, onClose }: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="How Analytics works"
      subtitle="Every metric here is derived from your real study sessions — 100% local, no estimates."
      widthClass="max-w-2xl"
    >
      {/* 1. Overview & Period Chart */}
      <Section icon={Info} title="Overview & Period Breakdown">
        <Term label="Total · 30 days">
          actual study hours logged over the last 30 days, along with the percentage change vs the prior 30 days.
        </Term>
        <Term label="Daily average">
          your typical daily study time across the 30-day window. Compare it to your ambition target to gauge your baseline pace.
        </Term>
        <Term label="Best run">
          your single highest-output study day in the window.
        </Term>
        <Term label="Focus sessions">
          the number of discrete study sittings and your average session duration.
        </Term>
        <Term label="Day / Week / Month">
          switch the breakdown: today vs yesterday + 24h timeline, this week vs last week with side-by-side daily bars, or a 30-day trend highlighting your peak day and target line.
        </Term>
      </Section>

      {/* 2. Pace Gauge & Peak Focus */}
      <Section icon={Gauge} title="Pace Gauge & Peak Windows">
        <p>
          The <span className="font-medium text-content-primary">Pace Gauge</span> tracks today's progress in real-time against your effective goal. If you have a schedule in Planning, that plan takes precedence; otherwise your daily ambition target fills in. It tells you whether you are ahead, on pace, or done for the day.
        </p>
        <div className="pt-1.5">
          <Term label="Golden window">
            the 2–3 consecutive hours where your highest focus output concentrates. Protect these hours for your most demanding subjects.
          </Term>
        </div>
      </Section>

      {/* 3. Study Insights */}
      <Section icon={Flame} title="Study Insights (Streaks & Rhythm)">
        <Term label="Streaks">
          consecutive active study days (both current run and your all-time record). On active days, an animated flame lights up to celebrate momentum.
        </Term>
        <Term label="Weekly rhythm">
          a 7-day breakdown revealing your historically strongest day of the week and its average study volume.
        </Term>
        <Term label="30-day consistency donut">
          percentage of days you showed up and studied in the last 30 days, plus the count of days that met or crushed your daily goal.
        </Term>
      </Section>

      {/* 4. Velocity & Focus Quality */}
      <Section icon={TrendingUp} title="Study Velocity & Focus Quality">
        <Term label="Cumulative velocity">
          tracks your running study trajectory this month against the ideal straight-line pace toward your monthly target. Shows your projected month-end total and your best rolling 7-day sprint.
        </Term>
        <Term label="Focus quality bento">
          analyzes real study sessions by grouping activity into continuous sittings (filtering micro-pauses under 5m) and recording your longest unbroken deep-work sprint.
        </Term>
      </Section>

      {/* 5. 12-Month Consistency Calendar */}
      <Section icon={CalendarDays} title="12-Month Consistency Calendar & Compare">
        <p>
          A full-year consistency heatmap arranged in three 4-month windows (
          <span className="font-medium text-content-primary">Jan–Apr</span>,{" "}
          <span className="font-medium text-content-primary">May–Aug</span>,{" "}
          <span className="font-medium text-content-primary">Sep–Dec</span>). Use the Year pill or arrow buttons to navigate across windows and past years.
        </p>
        <div className="pt-1.5 space-y-1">
          <p className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-[#EF4444]" />
            <span className="font-medium text-content-primary">Pure Red:</span> Below target — logged study time under target; a clear visual cue to stay consistent.
          </p>
          <p className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-[#2563EB]" />
            <span className="font-medium text-content-primary">Royal Azure Blue:</span> Target met — you reached 100% of your daily goal.
          </p>
          <p className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-[#F97316]" />
            <span className="font-medium text-content-primary">Vibrant Orange:</span> Over target — you exceeded your daily goal (110%+).
          </p>
          <p className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-[#181820]" />
            <span className="font-medium text-content-primary">Solid Slate:</span> Rest day — past day with intentional recovery.
          </p>
          <p className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] border border-dashed border-white/30 bg-transparent" />
            <span className="font-medium text-content-primary">Dashed Hollow:</span> Future date — unwritten days ahead.
          </p>
        </div>
        <div className="pt-2">
          <Term label="Compare mode">
            click any two calendar days (or use the Compare view toggle) to inspect their hour-by-hour distributions and metrics side-by-side.
          </Term>
        </div>
      </Section>

      {/* 6. Coaching & Balance */}
      <Section icon={Sparkles} title="Coaching Advice">
        <p>
          Build toward longer study targets <span className="font-medium text-content-primary">gradually</span>:
          add 15–30 minutes per week rather than jumping into unsustainable marathon sessions. Consistency beats intensity, and planned rest protects against burnout.
        </p>
      </Section>

      {/* 7. Privacy */}
      <Section icon={Shield} title="Data & Privacy">
        <p>
          All session history is stored <span className="font-medium text-content-primary">100% locally</span> in SQLite on your machine — zero cloud sync, zero telemetry. You can pause tracking, configure auto-pruning windows (e.g. 90/180/365 days), or clear all study data from the <span className="font-medium text-content-primary">Data &amp; privacy</span> sheet.
        </p>
      </Section>
    </Modal>
  );
}
