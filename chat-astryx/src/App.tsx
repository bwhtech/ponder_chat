import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Theme } from "@astryxdesign/core/theme";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { WifiIcon } from "@heroicons/react/24/outline";
import { Icon } from "@astryxdesign/core/Icon";
import { useEffect } from "react";
import { loadMe, me, meError } from "./lib/account";
import { loadModels } from "./lib/models";
import { useStore } from "./lib/store";
import { useToastBridge } from "./lib/toast";
import { themeMode, themeName } from "./lib/theme";
import { builtThemes, loadFonts } from "./lib/themes";
import { init } from "./lib/threads";
import SignIn from "./SignIn";
import Workspace from "./shell/Workspace";

let started = false;
void loadMe();

/** Sign-in first, then the workspace. */
export default function App() {
	const current = useStore(me);
	const mode = useStore(themeMode);
	const name = useStore(themeName);
	useEffect(() => loadFonts(name), [name]);

	// Offline at first: ask again when the connection comes back, or on Retry.
	useEffect(() => {
		const retry = () => me.get() === undefined && void loadMe();
		addEventListener("online", retry);
		return () => removeEventListener("online", retry);
	}, []);

	// The threads and the model list load once someone is signed in.
	useEffect(() => {
		if (!current || started) return;
		started = true;
		void init();
		void loadModels();
	}, [current]);

	return (
		<Theme theme={builtThemes[name]} mode={mode}>
			<ToastViewport>
				<Screens />
			</ToastViewport>
		</Theme>
	);
}

function Screens() {
	useToastBridge();
	const current = useStore(me);
	const error = useStore(meError);
	return (
		<>
			{current === undefined && error ? (
				<div className="flex h-dvh items-center justify-center">
					<EmptyState
						icon={<Icon icon={WifiIcon} size="lg" color="secondary" />}
						title="Can't reach Ponder"
						description={error}
						actions={<Button label="Try again" variant="primary" onClick={() => void loadMe()} />}
					/>
				</div>
			) : current === undefined ? (
				<div className="h-dvh" aria-busy="true" />
			) : current === null ? (
				<SignIn />
			) : (
				<Workspace />
			)}
		</>
	);
}
