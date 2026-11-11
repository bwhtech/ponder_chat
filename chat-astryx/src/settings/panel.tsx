import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Children, type ComponentType, type ReactNode, type SVGProps } from "react";

/**
 * The pieces each Settings panel is made of, after Astryx's settings-dialog template:
 * a heading, cards of rows, and rows with the setting's name on the left and its control
 * on the right. Every row on a panel stacks at once when the panel is under 480px wide
 * (the panel is a container, SettingsDialog.tsx), so the rows do not break one by one.
 */
export function PanelHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
			<div className="flex min-w-0 flex-col gap-0.5">
				<Heading level={2}>{title}</Heading>
				{description && (
					<Text type="supporting" color="secondary">
						{description}
					</Text>
				)}
			</div>
			{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
		</div>
	);
}

/** A muted card of rows, with dividers between them. */
export function SettingsCard({ title, children }: { title?: string; children: ReactNode }) {
	const rows = Children.toArray(children).filter(Boolean);
	return (
		<div className="flex flex-col gap-1.5">
			{title && (
				<Text type="supporting" weight="semibold" color="secondary">
					{title}
				</Text>
			)}
			<Card padding={0} width="100%" variant="muted">
				<ul className="flex flex-col">
					{rows.map((row, index) => (
						<li key={index} className="flex flex-col">
							{index > 0 && <Divider variant="subtle" />}
							{row}
						</li>
					))}
				</ul>
			</Card>
		</div>
	);
}

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** One setting: name and explanation, then its control. The row is the control's label, so the control hides its own. */
export function SettingsRow({ title, description, icon, control }: { title: string; description?: ReactNode; icon: IconComponent; control?: ReactNode }) {
	return (
		<div className="flex items-center gap-3 p-4 @max-[480px]:flex-col @max-[480px]:items-stretch @max-[480px]:gap-2">
			<div className="flex min-w-0 flex-1 items-start gap-2">
				<span className="pt-0.5">
					<Icon icon={icon} size="sm" color="secondary" />
				</span>
				<div className="flex max-w-[420px] min-w-0 flex-col gap-0.5 @max-[480px]:max-w-none">
					<Text type="label">{title}</Text>
					{description != null && (
						<Text type="supporting" color="secondary">
							{description}
						</Text>
					)}
				</div>
			</div>
			{control != null && <div className="flex shrink-0">{control}</div>}
		</div>
	);
}
