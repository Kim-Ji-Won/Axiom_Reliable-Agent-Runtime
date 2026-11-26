export function readApprovalTime(): bigint {
  return process.hrtime.bigint();
}
