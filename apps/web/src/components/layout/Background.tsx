/**
 * Ambient backdrop: soft lavender daylight with pastel light pools and two glossy spheres,
 * as in the reference designs. Purely decorative, fixed behind the workspace.
 */
export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-canvas">
      <div className="absolute -left-40 -top-48 size-[680px] rounded-full bg-[#dfe3fb] opacity-90 blur-[120px] dark:bg-[#2a2560] dark:opacity-40" />
      <div className="absolute -right-32 top-10 size-[560px] rounded-full bg-[#f6dcec] opacity-80 blur-[120px] dark:bg-[#4a1f45] dark:opacity-30" />
      <div className="absolute bottom-[-260px] left-1/3 size-[720px] rounded-full bg-[#efd3f1] opacity-70 blur-[140px] dark:bg-[#3a1d5a] dark:opacity-35" />
      <div className="absolute bottom-10 right-1/4 size-[380px] rounded-full bg-[#d6ecf5] opacity-60 blur-[110px] dark:bg-[#12324a] dark:opacity-30" />
      {/* glossy spheres */}
      <div
        className="absolute left-[3%] top-[46%] size-10 animate-float rounded-full dark:opacity-20"
        style={{ background: 'radial-gradient(circle at 32% 30%, #ffffff 0%, #f4f1fb 55%, #e3def3 100%)', boxShadow: '0 12px 30px -10px rgba(90,70,160,.25)' }}
      />
      <div
        className="absolute bottom-[6%] left-[8%] size-24 animate-float rounded-full [animation-delay:-6s] dark:opacity-20"
        style={{ background: 'radial-gradient(circle at 32% 30%, #ffffff 0%, #f6f3fc 50%, #e7e1f5 100%)', boxShadow: '0 24px 50px -18px rgba(90,70,160,.28)' }}
      />
    </div>
  );
}
