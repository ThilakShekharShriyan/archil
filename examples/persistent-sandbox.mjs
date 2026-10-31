import * as archil from "disk";

const apiKey = process.env.ARCHIL_API_KEY;
const region = process.env.ARCHIL_REGION;

if (!apiKey || !region) {
  console.error("Set ARCHIL_API_KEY and ARCHIL_REGION, then run: npm run example");
  process.exit(1);
}

archil.configure({ apiKey, region });

const markerPath = "/var/archil-demo/marker.txt";
const marker = `still here ${new Date().toISOString()}`;

const sandbox = await archil.createSandbox({
  name: "persist-demo",
  baseImage: "ubuntu:24.04",
  vcpuCount: 1,
  memSizeMiB: 512,
  maxTtlSeconds: 600,
  idleTtlSeconds: 300,
});

console.log(`created sandbox ${sandbox.id}`);

try {
  const write = await sandbox.exec(
    `mkdir -p /var/archil-demo && printf '%s\\n' ${JSON.stringify(marker)} > ${markerPath} && cat ${markerPath}`,
  );
  if (write.exitCode !== 0) {
    throw new Error(`write failed (${write.exitCode}): ${write.stderr}`);
  }
  console.log(`wrote: ${write.stdout.trim()}`);

  await sandbox.stop();
  console.log("stopped");

  await sandbox.start();
  console.log("started again");

  const read = await sandbox.exec(`cat ${markerPath}`);
  if (read.exitCode !== 0) {
    throw new Error(`read failed (${read.exitCode}): ${read.stderr}`);
  }
  const persisted = read.stdout.trim();
  console.log(`read after restart: ${persisted}`);

  if (persisted !== marker) {
    throw new Error("file did not survive stop/start");
  }
  console.log("file persisted across stop and start");
} finally {
  try {
    await sandbox.stop();
    console.log(`stopped sandbox ${sandbox.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`could not stop sandbox ${sandbox.id}: ${message}`);
  }
}
