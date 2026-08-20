import { BaseBottomNav } from "./BaseBottomNav";
import { BaseStatusBar } from "./BaseStatusBar";

/** koi.fun persistent chrome: the floating bottom nav on mobile and the fixed
 *  status strip on desktop. No traditional footer. */
export function BaseFooter() {
  return (
    <>
      <BaseBottomNav />
      <BaseStatusBar />
    </>
  );
}
