import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { Header } from "./api";

/** Header rows for servers that take an API key. Values are saved encrypted, and never shown again. */
export default function HeadersInput({ rows, onChange, namesFixed = false }: { rows: Header[]; onChange: (rows: Header[]) => void; namesFixed?: boolean }) {
	const change = (index: number, patch: Partial<Header>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
	return (
		<div className="flex flex-col gap-2">
			{rows.length > 0 && (
				<div className="flex gap-2" aria-hidden="true">
					<span className="w-40 shrink-0">
						<Text type="supporting">Header</Text>
					</span>
					<Text type="supporting">Value</Text>
				</div>
			)}
			{rows.map((row, index) => (
				<div key={index} className="flex items-center gap-2">
					<TextInput
						label="Header"
						isLabelHidden
						width={160}
						value={row.name}
						isDisabled={namesFixed}
						placeholder="Authorization"
						autoComplete="off"
						onChange={(name) => change(index, { name })}
					/>
					<div className="min-w-0 flex-1">
						<TextInput
							type="password"
							label={`Value of ${row.name || "the header"}`}
							isLabelHidden
							width="100%"
							value={row.value}
							placeholder="Bearer sk-…"
							autoComplete="off"
							onChange={(value) => change(index, { value })}
						/>
					</div>
					{!namesFixed && (
						<IconButton
							label={`Remove ${row.name || "this header"}`}
							variant="ghost"
							icon={<Icon icon={XMarkIcon} />}
							onClick={() => onChange(rows.filter((_, i) => i !== index))}
						/>
					)}
				</div>
			))}
			{!namesFixed && (
				<div>
					<Button label="Add header" size="sm" variant="secondary" icon={<Icon icon={PlusIcon} />} onClick={() => onChange([...rows, { name: "", value: "" }])} />
				</div>
			)}
		</div>
	);
}
