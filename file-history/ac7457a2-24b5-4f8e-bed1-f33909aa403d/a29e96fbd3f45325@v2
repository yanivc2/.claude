import { useCurrentFrame, spring, interpolate, Easing } from "remotion";

type StatsRowProps = { fps: number };

type StatCardData = {
  label: string;
  value: string;
  delta: string;
  positive: boolean;
  color: string;
};

const STATS: StatCardData[] = [
  { label: "Uptime", value: "99.98%", delta: "+0.02%", positive: true, color: "#34D399" },
  { label: "Avg Latency", value: "42ms", delta: "-8ms", positive: true, color: "#38BDF8" },
  { label: "Req / min", value: "12,840", delta: "+1,200", positive: true, color: "#818CF8" },
  { label: "Error Rate", value: "0.04%", delta: "-0.01%", positive: true, color: "#FB923C" },
];

export const StatsRow: React.FC<StatsRowProps> = ({ fps }) => {
  const frame = useCurrentFrame();

  return (
    <div style={{ display: "flex", gap: 32, flex: 1 }}>
      {STATS.map((stat, i) => {
        const delay = i * 12;
        const scale = spring({
          frame: frame - delay,
          fps,
          config: { damping: 14, stiffness: 120 },
        });
        const opacity = interpolate(frame - delay, [0, 15], [0, 1], {
          extrapolateRight: "clamp",
          extrapolateLeft: "clamp",
        });

        return (
          <div
            key={stat.label}
            style={{
              flex: 1,
              background: "#1E293B",
              border: "1px solid #334155",
              borderRadius: 16,
              padding: "36px 32px",
              transform: `scale(${scale})`,
              opacity,
            }}
          >
            <div style={{ fontSize: 15, color: "#94A3B8", marginBottom: 16, fontWeight: 500 }}>
              {stat.label}
            </div>
            <CountUp frame={frame} delay={delay + 20} fps={fps} stat={stat} />
            <div
              style={{
                marginTop: 12,
                fontSize: 14,
                color: stat.positive ? "#34D399" : "#F87171",
                fontWeight: 600,
              }}
            >
              {stat.delta} vs last hour
            </div>
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 3,
                borderRadius: "16px 16px 0 0",
                background: stat.color,
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

type CountUpProps = { frame: number; delay: number; fps: number; stat: StatCardData };

const CountUp: React.FC<CountUpProps> = ({ frame, delay, fps, stat }) => {
  const progress = interpolate(frame - delay, [0, 45], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Show final value directly for non-numeric values
  const display = stat.value;

  return (
    <div style={{ fontSize: 48, fontWeight: 800, color: "#F1F5F9", letterSpacing: "-1px" }}>
      <span style={{ opacity: progress }}>{display}</span>
    </div>
  );
};
