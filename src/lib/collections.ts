/** The value at key, created by init() the first time. */
export function getOrInit<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (v === undefined) map.set(key, (v = init()));
  return v;
}

/** xs in slices of at most n, for SQL IN lists that must stay under SQLite's variable limit. */
export function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
