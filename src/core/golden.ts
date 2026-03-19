export interface ResolveGoldenCommitOptions {
	commitId?: string;
	env?: NodeJS.ProcessEnv;
	infraUrl?: string;
	authToken?: string;
	fetchImpl?: typeof fetch;
	ensure?: boolean;
}

export interface ResolveGoldenCommitResult {
	commitId: string;
	source: "explicit" | "env" | "reef-commits" | "reef-registry" | "reef-ensure";
}

function defaultInfraUrl(env: NodeJS.ProcessEnv): string | undefined {
	if (env.VERS_INFRA_URL) return env.VERS_INFRA_URL;
	if (env.VERS_VM_ID) return `https://${env.VERS_VM_ID}.vm.vers.sh:${env.PORT || "3000"}`;
	if (env.PORT) return `http://127.0.0.1:${env.PORT}`;
	return undefined;
}

async function requestJson<T>(
	fetchImpl: typeof fetch,
	baseUrl: string,
	path: string,
	method = "GET",
	authToken?: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; payload: T | null }> {
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (authToken) headers.Authorization = `Bearer ${authToken}`;

	try {
		const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		return {
			ok: response.ok,
			status: response.status,
			payload: text ? (JSON.parse(text) as T) : null,
		};
	} catch {
		return { ok: false, status: 0, payload: null };
	}
}

export async function resolveGoldenCommit(
	options: ResolveGoldenCommitOptions = {},
): Promise<ResolveGoldenCommitResult> {
	if (options.commitId?.trim()) {
		return { commitId: options.commitId.trim(), source: "explicit" };
	}

	const env = options.env ?? process.env;
	const envCommitId = env.VERS_GOLDEN_COMMIT_ID || env.VERS_COMMIT_ID;
	if (envCommitId?.trim()) {
		return { commitId: envCommitId.trim(), source: "env" };
	}

	const fetchImpl = options.fetchImpl ?? fetch;
	const infraUrl = options.infraUrl || defaultInfraUrl(env);
	const authToken = options.authToken || env.VERS_AUTH_TOKEN;

	if (infraUrl) {
		const currentGolden = await requestJson<{ commitId?: string }>(
			fetchImpl,
			infraUrl,
			"/commits/current/golden",
			"GET",
			authToken,
		);
		if (currentGolden.ok && currentGolden.payload?.commitId) {
			return { commitId: currentGolden.payload.commitId, source: "reef-commits" };
		}

		const registryGolden = await requestJson<{ vms?: Array<{ metadata?: { commitId?: string } }> }>(
			fetchImpl,
			infraUrl,
			"/registry/vms?role=golden",
			"GET",
			authToken,
		);
		const registryCommitId = registryGolden.payload?.vms?.find((vm) => vm.metadata?.commitId)?.metadata?.commitId;
		if (registryGolden.ok && registryCommitId) {
			return { commitId: registryCommitId, source: "reef-registry" };
		}

		if (options.ensure) {
			const ensured = await requestJson<{ commitId?: string }>(
				fetchImpl,
				infraUrl,
				"/commits/ensure-golden",
				"POST",
				authToken,
				{},
			);
			if (ensured.ok && ensured.payload?.commitId) {
				return { commitId: ensured.payload.commitId, source: "reef-ensure" };
			}
		}
	}

	throw new Error(
		"No golden commit available. Pass commitId explicitly, set VERS_GOLDEN_COMMIT_ID/VERS_COMMIT_ID, or configure a Reef root with /commits/ensure-golden.",
	);
}
