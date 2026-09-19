import { Autopilot } from "./autopilot";
import { BuiltOn } from "./built-on";
import { Cannot } from "./cannot";
import { Cap } from "./cap";
import { Close } from "./close";
import { Spine } from "./spine";
import { Wall } from "./wall";
import { Yours } from "./yours";
import styles from "./story.module.css";

export function Story() {
  return (
    <div className={styles.story}>
      <div className={styles.bands}>
        <Cap />
        <Autopilot />
        <Yours />
        <Wall />
        <Cannot />
        <BuiltOn />
        <Close />
      </div>
      <Spine />
    </div>
  );
}
