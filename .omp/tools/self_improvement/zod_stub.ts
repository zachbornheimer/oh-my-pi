/** A chainable stand-in for `pi.zod` used by the unit test: every builder call returns the same recording proxy. */
export const zodStub: unknown = (() => {
  const chain: unknown = new Proxy(function () {}, {
    get: () => chain,
    apply: () => chain,
  });
  return chain;
})();
