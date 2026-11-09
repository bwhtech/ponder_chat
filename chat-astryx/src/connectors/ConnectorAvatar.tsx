/** A connector's first letter on a colour picked from its name, so each keeps its colour. */
const TONES = [
	"bg-blue-subtle text-blue-vivid",
	"bg-green-subtle text-green-vivid",
	"bg-yellow-subtle text-yellow-vivid",
	"bg-purple-subtle text-purple-vivid",
	"bg-red-subtle text-red-vivid",
	"bg-gray-subtle text-gray-vivid",
];

const SIZES = { md: "size-9 text-base", lg: "size-12 text-xl" };

export default function ConnectorAvatar({ name, size = "md" }: { name: string; size?: keyof typeof SIZES }) {
	const tone = TONES[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TONES.length];
	return (
		<span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-md font-semibold ${SIZES[size]} ${tone}`}>
			{[...name.trim()][0]?.toUpperCase() ?? "?"}
		</span>
	);
}
