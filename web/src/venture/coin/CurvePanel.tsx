
import { CURVE_SUPPLY, TOTAL_SUPPLY, type Venture as VentureT } from "../client";
import { gradValueWei } from "../curve";
import { fmtEth, fmtUsdV, pct, useEthUsd } from "../ui";


export function CurvePanel({ v }: { v: VentureT }) {
  const bars = 36;
  const ethUsd = useEthUsd();
  // The curve's shape and where it stands on it: filled bars are sold, the
  // rest is what is left before graduation. Progress for both modes lives
  // here, on the chart, where the eye already is.
  const filled = v.raisedWei >= v.targetRaiseWei ? 100 : pct(v.raisedWei, v.targetRaiseWei);
  const soldFrac = Number(v.soldWhole) / CURVE_SUPPLY;
  const left = v.targetRaiseWei > v.raisedWei ? v.targetRaiseWei - v.raisedWei : 0n;
  const gradFdv = Number(gradValueWei(v, BigInt(TOTAL_SUPPLY))) / 1e18;
  return (
    <div className="dp-panel dp-chartpanel">
      <div className="dp-phead">
        {v.phase === "failed" ? (
          <><span>Missed its target at {filled.toFixed(0)}%</span><span>refunds are open</span></>
        ) : (
          <>
            <span>{filled.toFixed(0)}% filled · {fmtEth(left, 3)} ETH to go</span>
            <span>graduates at {ethUsd > 0 ? fmtUsdV(gradFdv * ethUsd) : `${gradFdv.toFixed(2)} ETH`} market cap</span>
          </>
        )}
      </div>
      <div className="dp-pbody">
        <svg className="dp-px" width="100%" viewBox="0 0 560 150" preserveAspectRatio="none" style={{ height: 150 }} aria-hidden>
          {Array.from({ length: bars }, (_, i) => {
            const h = 18 + (i / (bars - 1)) * 120;
            const sold = (i + 1) / bars <= soldFrac + 1e-9;
            return <rect key={i} x={i * 15.5 + 2} y={142 - h} width={11} height={h}
              fill="var(--up)" opacity={sold ? 0.85 : 0.14} />;
          })}
        </svg>
      </div>
    </div>
  );
}
