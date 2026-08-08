import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import {
  LogOut,
  HelpCircle,
  KeyRound,
  WifiOff,
  Wifi,
  ShieldCheck,
  Link as LinkIcon,
  LayoutDashboard,
  Import,
  Library,
  Settings,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import Breadcrumb from "../../components/layout/Breadcrumb";
import ConnectFlow from "./ConnectFlow";
import LinkImport from "./LinkImport";
import ImportHistory from "./ImportHistory";
import { useAuth } from "./authStore";
import { cn } from "../../lib/utils";
import { TelegramIcon } from "../../components/ui/TelegramIcon";

type Tab = "overview" | "import" | "library" | "settings";

export default function TelegramPage() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const hasCredentials = useAuth((s) => s.hasCredentials);
  const signOut = useAuth((s) => s.signOut);

  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [refreshKey, setRefreshKey] = useState(0);

  const pillRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<SVGSVGElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);

  const connected = status === "connected";

  useGSAP(() => {
    if (connected) {
      // Glow pulse animation
      gsap.to(pillRef.current, {
        boxShadow: "inset 0 1px 1px rgba(255,255,255,0.4), 0 0 15px rgba(42,171,238,0.6), 0 8px 16px rgba(0,0,0,0.4)",
        duration: 1.5,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      });
      // Icon gentle bob
      gsap.to(iconRef.current, {
        y: -1,
        duration: 1,
        repeat: -1,
        yoyo: true,
        ease: "power1.inOut"
      });
      // Name 3D float
      if (nameRef.current) {
        gsap.fromTo(nameRef.current,
          { y: 5, opacity: 0, rotationX: -15 },
          { y: 0, opacity: 1, rotationX: 0, duration: 0.8, ease: "back.out(1.5)" }
        );
        gsap.to(nameRef.current, {
          y: -1.5,
          rotationX: 5,
          duration: 2,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
          delay: 0.8
        });
      }
    } else if (status === "unreachable") {
      // Alert pulse animation
      gsap.to(pillRef.current, {
        boxShadow: "inset 0 1px 1px rgba(255,255,255,0.4), 0 0 20px rgba(249,115,22,0.8), 0 8px 16px rgba(0,0,0,0.5)",
        borderColor: "rgba(249,115,22,0.6)",
        duration: 0.8,
        repeat: -1,
        yoyo: true,
        ease: "power2.inOut"
      });
      // Icon shake animation
      gsap.to(iconRef.current, {
        x: 2,
        duration: 0.1,
        repeat: -1,
        yoyo: true,
        ease: "power1.inOut"
      });
    } else {
      gsap.killTweensOf([pillRef.current, iconRef.current, nameRef.current]);
      gsap.set(pillRef.current, { clearProps: "all" });
      gsap.set(iconRef.current, { clearProps: "all" });
      gsap.set(nameRef.current, { clearProps: "all" });
    }
  }, { dependencies: [connected, status] });
  const hasSession = connected || status === "unreachable";
  const displayName =
    user?.first_name || (user?.username ? `@${user.username}` : null) || "your account";

  const tabs = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "import", label: "Import Media", icon: Import },
    { id: "library", label: "My Library", icon: Library },
    { id: "settings", label: "Settings", icon: Settings },
  ] as const;

  const renderTabContent = () => {
    switch (activeTab) {
      case "overview":
        return (
          <div className="space-y-6">
             {/* Unreachable notice */}
            {status === "unreachable" && (
              <div className="flex items-start gap-2.5 rounded-btn border border-orange/30 bg-orange/10 p-3">
                <WifiOff size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-orange" aria-hidden />
                <p className="text-sm text-content-secondary">
                  Your session is saved — there's no need to sign in again. This will reconnect on
                  its own once Telegram is reachable.
                </p>
              </div>
            )}
            
            {hasSession ? (
              <div className="glass rounded-card p-card shadow-card relative overflow-hidden">
                 <div
                    aria-hidden
                    className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-[#2AABEE]/[0.12] blur-[100px]"
                 />
                 <div className="relative">
                   <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-[#2AABEE]/30 bg-[#2AABEE]/15 shadow-[0_0_15px_rgba(42,171,238,0.2)]">
                        <TelegramIcon className="h-6 w-6 text-[#2AABEE]" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-base font-semibold text-content-primary">
                          Connected as {displayName}
                        </p>
                        <p className="truncate text-sm text-[#2AABEE]">
                          {user?.username ? `@${user.username}` : user?.phone ?? "Connected"}
                        </p>
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-content-faint sm:ml-auto">
                      <ShieldCheck size={13} strokeWidth={2} className="text-[#2AABEE]" aria-hidden />
                      Read-only access
                    </span>
                   </div>
                   <div className="mt-6 flex flex-wrap gap-4">
                     <button
                        onClick={() => setActiveTab("import")}
                        className="inline-flex items-center gap-2 rounded-btn bg-[#2AABEE] px-4 py-2 text-sm font-semibold text-white shadow-[0_0_15px_rgba(42,171,238,0.3)] transition-transform hover:scale-[1.02] active:scale-[0.98]"
                     >
                       <Import size={15} strokeWidth={2.5} />
                       Quick Import
                     </button>
                     <button
                        onClick={() => setActiveTab("library")}
                        className="inline-flex items-center gap-2 rounded-btn border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
                     >
                       <Library size={15} strokeWidth={2} />
                       Browse Library
                     </button>
                   </div>
                 </div>
              </div>
            ) : (
               <div className="glass rounded-card p-card shadow-card flex flex-col items-center justify-center py-12 text-center">
                 <span className="grid h-16 w-16 place-items-center rounded-3xl border border-white/10 bg-white/[0.02]">
                    <TelegramIcon className="h-8 w-8 text-content-faint" />
                 </span>
                 <h2 className="mt-4 font-display text-lg font-semibold text-content-primary">Not Connected</h2>
                 <p className="mt-2 text-sm text-content-muted max-w-sm">
                   Connect your Telegram account to start importing lessons, videos, and notes directly into your library.
                 </p>
                 <button
                    onClick={() => setActiveTab("settings")}
                    className="mt-6 inline-flex items-center gap-2 rounded-btn bg-lime px-5 py-2.5 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] active:scale-[0.98]"
                 >
                   Connect Account
                 </button>
               </div>
            )}
          </div>
        );
      case "import":
        return (
          <div className="space-y-4">
             {hasSession && connected ? (
               <section aria-labelledby="tg-import-title" className="glass relative overflow-hidden rounded-panel p-card shadow-card">
                 <div aria-hidden className="pointer-events-none absolute -left-20 -top-20 h-64 w-64 rounded-full bg-lime/[0.08] blur-[120px]" />
                 <div className="relative mb-6 flex items-center gap-3">
                   <span className="grid h-10 w-10 place-items-center rounded-xl border border-lime/25 bg-lime/10">
                     <LinkIcon size={18} strokeWidth={2} className="text-lime" aria-hidden />
                   </span>
                   <div>
                     <h2 id="tg-import-title" className="font-display text-lg font-semibold text-content-primary">
                       Import Hub
                     </h2>
                     <p className="text-sm text-content-muted">
                       Paste a single link or browse a whole channel.
                     </p>
                   </div>
                 </div>
                 <div className="relative">
                   <LinkImport onImported={() => setRefreshKey((k) => k + 1)} />
                 </div>
               </section>
             ) : (
               <div className="rounded-btn border border-orange/30 bg-orange/10 p-4 flex items-center gap-3 text-orange">
                 <WifiOff size={18} strokeWidth={2} />
                 <span className="text-sm">You must be connected to Telegram to import media.</span>
               </div>
             )}
          </div>
        );
      case "library":
        return (
           <div className="space-y-4">
              {hasSession && connected ? (
                 <ImportHistory refreshKey={refreshKey} />
              ) : (
                <div className="rounded-btn border border-orange/30 bg-orange/10 p-4 flex items-center gap-3 text-orange">
                   <WifiOff size={18} strokeWidth={2} />
                   <span className="text-sm">You must be connected to Telegram to view history.</span>
                </div>
              )}
           </div>
        );
      case "settings":
        return (
          <div className="space-y-6">
            <div className="glass rounded-card p-card shadow-card">
              <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-base font-semibold text-content-primary">
                    Connection Settings
                  </h2>
                  <p className="mt-1 text-sm text-content-muted">
                    Sign in with your own Telegram account. The connection runs locally, nothing is uploaded.
                  </p>
                </div>
                {!hasCredentials && (
                  <Link
                    to="/settings#plugins"
                    className="inline-flex shrink-0 items-center gap-2 rounded-btn border border-white/10 px-4 py-2.5 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary"
                  >
                    <KeyRound size={15} strokeWidth={2} aria-hidden />
                    Add credentials
                  </Link>
                )}
                {hasSession && (
                  <button
                    type="button"
                    onClick={() => void signOut()}
                    className="inline-flex shrink-0 items-center gap-2 rounded-btn border border-white/10 px-3.5 py-2 text-sm font-medium text-content-secondary transition-colors hover:border-orange/40 hover:bg-orange/10 hover:text-orange"
                  >
                    <LogOut size={15} strokeWidth={2} aria-hidden />
                    Disconnect
                  </button>
                )}
              </div>
              {!hasSession && (
                <div className="mt-6 border-t border-white/[0.06] pt-6">
                  <ConnectFlow />
                </div>
              )}
            </div>
            
            <p className="flex items-center gap-1.5 text-xs text-content-faint">
              <HelpCircle size={13} strokeWidth={2} aria-hidden />
              Telegram access is read-only — imported lessons stream on demand and are not copied to your disk.
            </p>
          </div>
        );
    }
  };

  return (
    <div className="min-h-full px-6 pb-10">
      <div className="mx-auto max-w-[1400px]">
        <Breadcrumb items={[{ label: "Plugins", to: "/plugins" }, { label: "Telegram" }]} />

        {/* ── Hero / Brand Strip ─────────────────────────────────────────────────────────── */}
        <header className="relative mt-3 mb-6 overflow-hidden rounded-2xl glass shadow-[0_4px_30px_rgba(0,0,0,0.1)] border border-white/[0.05]">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-[#2AABEE]/[0.08] blur-[110px]"
          />
          <div className="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-center justify-between">
            <div className="flex items-center gap-3">
               <span
                 aria-hidden
                 className="relative grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-[#2AABEE]/25 bg-[#2AABEE]/10 shadow-[0_0_15px_rgba(42,171,238,0.2)]"
               >
                 <TelegramIcon className="h-6 w-6 text-[#2AABEE]" />
                 <span className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/[0.06]" />
               </span>
               <div>
                  <h1 className="font-display text-xl font-bold tracking-tight text-content-primary">
                    Telegram
                  </h1>
                  <p className="text-xs text-content-muted">Stream and import private-channel media seamlessly.</p>
               </div>
            </div>
                          {/* Live status pill & Name */}
              <div className="flex flex-col items-end gap-1.5">
                <span
                   ref={pillRef}
                   className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide transition-all duration-300",
                      connected
                         ? "border-[#2AABEE]/40 bg-gradient-to-r from-[#2AABEE]/20 to-[#4D7CFF]/20 text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.2),0_4px_12px_rgba(42,171,238,0.2)]"
                         : status === "unreachable"
                         ? "border-orange/40 bg-gradient-to-r from-orange/20 to-red/20 text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.2),0_4px_12px_rgba(249,115,22,0.2)]"
                         : "border-white/10 bg-white/[0.04] text-content-faint"
                   )}
                >
                   {status === "unreachable" ? (
                     <WifiOff ref={iconRef as any} size={12} strokeWidth={2.5} className="text-orange" />
                   ) : connected ? (
                     <Wifi ref={iconRef as any} size={12} strokeWidth={2.5} className="text-[#2AABEE]" />
                   ) : (
                     <span
                        aria-hidden
                        className="h-1.5 w-1.5 rounded-full bg-white/20"
                     />
                   )}
                   {connected ? "Connected" : status === "unreachable" ? "Offline" : "Idle"}
                </span>
                
                {connected && displayName && (
                     <span 
                       ref={nameRef}
                       className="text-sm font-display font-bold tracking-wide mr-1.5"
                       style={{
                         color: "#2AABEE",
                         textShadow: "0px 1px 0px #0e5b85, 0px 2px 0px #0b4566, 0px 4px 6px rgba(0,0,0,0.6)",
                         transformStyle: "preserve-3d"
                       }}
                     >
                       {displayName}
                     </span>
                  )}
              </div>
            </div>
          </header>

        <div className="flex flex-col lg:flex-row gap-6">
           {/* Sidebar Navigation */}
           <nav className="shrink-0 lg:w-48 xl:w-56 flex flex-row lg:flex-col gap-1.5 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0 hide-scrollbar">
              {tabs.map((tab) => {
                 const isActive = activeTab === tab.id;
                 const Icon = tab.icon;
                 return (
                    <button
                       key={tab.id}
                       onClick={() => setActiveTab(tab.id)}
                       className={cn(
                          "relative flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-all w-full text-left whitespace-nowrap",
                          isActive
                             ? "text-content-primary"
                             : "text-content-secondary hover:bg-white/[0.03] hover:text-content-primary"
                       )}
                    >
                       {isActive && (
                          <motion.div
                             layoutId="sidebar-active"
                             className="absolute inset-0 rounded-lg bg-white/[0.06] border border-white/[0.05]"
                             initial={false}
                             transition={{ type: "spring", stiffness: 400, damping: 30 }}
                          />
                       )}
                       <Icon 
                          size={16} 
                          strokeWidth={isActive ? 2.5 : 2} 
                          className={cn("relative z-10", isActive ? "text-[#2AABEE]" : "")} 
                       />
                       <span className="relative z-10">{tab.label}</span>
                    </button>
                 );
              })}
           </nav>

           {/* Viewport content */}
           <div className="min-w-0 flex-1">
              <AnimatePresence mode="wait">
                 <motion.div
                    key={activeTab}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                 >
                    {renderTabContent()}
                 </motion.div>
              </AnimatePresence>
           </div>
        </div>

      </div>
    </div>
  );
}
