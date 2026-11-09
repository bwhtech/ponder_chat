import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SparklesIcon } from "@heroicons/react/24/outline";

/** Ponder beside its replies: the same accent mark as the side nav, so it follows the theme. */
export default function PonderAvatar() {
	return (
		<span aria-label="Ponder" role="img">
			<NavIcon icon={<Icon icon={SparklesIcon} size="sm" />} />
		</span>
	);
}
