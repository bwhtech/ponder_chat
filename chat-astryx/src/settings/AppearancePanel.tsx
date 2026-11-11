import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Theme } from "@astryxdesign/core/theme";
import { useStore } from "../lib/store";
import { THEMES, themeMode, themeName, type ThemeMode } from "../lib/theme";
import { builtThemes, loadFonts } from "../lib/themes";
import { PanelHeading } from "./panel";

/**
 * How Ponder looks: one of Astryx's themes, and light, dark or the device's choice. Each
 * card is drawn in its own theme, so it shows the real colours, type and shapes.
 */
export default function AppearancePanel() {
	const name = useStore(themeName);
	const mode = useStore(themeMode);
	return (
		<VStack gap={6}>
			<PanelHeading title="Appearance" description="Kept in this browser." />
			<VStack gap={2}>
				<Text type="label">Mode</Text>
				<SegmentedControl label="Mode" value={mode} onChange={(value) => themeMode.set(value as ThemeMode)}>
					<SegmentedControlItem value="light" label="Light" />
					<SegmentedControlItem value="dark" label="Dark" />
					<SegmentedControlItem value="system" label="System" />
				</SegmentedControl>
			</VStack>
			<VStack gap={2}>
				<Text type="label">Theme</Text>
				<Grid columns={{ minWidth: 200, max: 3 }} gap={3}>
					{THEMES.map((theme) => (
						<div key={theme.name} onPointerEnter={() => loadFonts(theme.name)}>
							<Theme theme={builtThemes[theme.name]} mode={mode}>
								<SelectableCard label={theme.label} isSelected={theme.name === name} onChange={() => themeName.set(theme.name)} padding={3} width="100%">
									<VStack gap={3}>
										<HStack gap={2} vAlign="center">
											<Avatar name="Ponder" size="xsm" />
											<div className="min-w-0 flex-1 rounded-lg bg-muted px-2.5 py-1.5">
												<Text type="supporting">What's on your mind?</Text>
											</div>
										</HStack>
										<HStack gap={2} vAlign="center" hAlign="between">
											<VStack gap={0}>
												<Heading level={4}>{theme.label}</Heading>
												<Text type="supporting" color="secondary">
													{theme.description}
												</Text>
											</VStack>
										</HStack>
										<HStack gap={1.5}>
											<Button label="Send" variant="primary" size="sm" />
											<Button label="Stop" variant="secondary" size="sm" />
										</HStack>
									</VStack>
								</SelectableCard>
							</Theme>
						</div>
					))}
				</Grid>
			</VStack>
		</VStack>
	);
}
