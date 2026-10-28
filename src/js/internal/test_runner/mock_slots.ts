// The properties that hold a `node:test` mock, for the boundary between two
// test files of one `bun test` run. A slot is one property: an object and a key.
//
// node runs each test file in a process of its own, so a mock that a file
// leaves installed ends with that process. `bun test` runs its files in one
// realm, and node:test puts every slot back before the next file is loaded.
// MockTracker.reset() cannot do that alone. As in node, each mock writes back
// the descriptor it found, in the order the mocks were made, so a slot that
// was mocked twice ends up holding its first mock:
// https://github.com/nodejs/node/blob/50c35fea9e64d50ab3bb5f359e8523de89d6c798/lib/internal/test_runner/mock/mock.js#L746-L752
// So each slot that holds a mock is listed here with the descriptor it had
// before the first one.

// Captured at load: a test can mock these methods.
const WeakMapPrototypeGet = WeakMap.prototype.get;
const WeakMapPrototypeSet = WeakMap.prototype.set;

// undefined where nothing calls restoreMockedSlots(): outside `bun test`, and in a Worker.
let mockedSlots: Map<object, Map<PropertyKey, PropertyDescriptor>> | undefined;
// For a mock made in a slot that already held one: the descriptor it found → the one before the first mock.
const origins = new WeakMap<PropertyDescriptor, PropertyDescriptor>();

function trackMockedSlots() {
  mockedSlots ??= new Map();
}

/** A mock replaced `object[key]`, which held `found`. */
function slotMocked(object: object, key: PropertyKey, found: PropertyDescriptor) {
  if (mockedSlots === undefined) return;
  let keys = mockedSlots.$get(object);
  if (keys === undefined) mockedSlots.$set(object, (keys = new Map()));
  const origin = keys.$get(key);
  if (origin === undefined) keys.$set(key, found);
  else WeakMapPrototypeSet.$call(origins, found, origin);
}

/** A mock wrote `found`, the descriptor `slotMocked()` got, back to `object[key]`. */
function slotRestored(object: object, key: PropertyKey, found: PropertyDescriptor) {
  if (mockedSlots === undefined) return;
  const origin: PropertyDescriptor | undefined = WeakMapPrototypeGet.$call(origins, found);
  let keys = mockedSlots.$get(object);
  if (origin !== undefined) {
    // `found` is an earlier mock, and the slot holds it again.
    if (keys === undefined) mockedSlots.$set(object, (keys = new Map()));
    keys.$set(key, origin);
  } else if (keys !== undefined && keys.$delete(key) && keys.$size === 0) {
    mockedSlots.$delete(object);
  }
}

/** Gives every slot that still holds a mock the descriptor it had before its first mock. */
function restoreMockedSlots() {
  const slots = mockedSlots;
  if (slots === undefined || slots.$size === 0) return;
  // A setter or a proxy that a restore runs can mock again. That mock belongs to the next file.
  mockedSlots = new Map();
  slots.$forEach((keys, object) => {
    keys.$forEach((origin, key) => {
      try {
        Object.defineProperty(object, key, origin);
      } catch {
        // A slot can refuse: mock.getter() on a stream gives the stream an own accessor that is
        // not configurable. node never restores it, its process ends, so nothing fails here.
      }
    });
  });
}

export default { trackMockedSlots, slotMocked, slotRestored, restoreMockedSlots };
