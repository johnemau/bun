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
// The key comes first: a test file mocks few property names, on any number of objects. The map
// of a name is made once and kept, so a mock allocates nothing here.
let mockedSlots: Map<PropertyKey, Map<object, PropertyDescriptor>> | undefined;
// For a mock made in a slot that already held one: the descriptor it found → the one before the first mock.
const origins = new WeakMap<PropertyDescriptor, PropertyDescriptor>();

function trackMockedSlots() {
  mockedSlots ??= new Map();
}

/** A mock replaced `object[key]`, which held `found`. */
function slotMocked(object: object, key: PropertyKey, found: PropertyDescriptor) {
  if (mockedSlots === undefined) return;
  let objects = mockedSlots.$get(key);
  if (objects === undefined) mockedSlots.$set(key, (objects = new Map()));
  const origin = objects.$get(object);
  if (origin === undefined) objects.$set(object, found);
  else WeakMapPrototypeSet.$call(origins, found, origin);
}

/** A mock wrote `found`, the descriptor `slotMocked()` got, back to `object[key]`. */
function slotRestored(object: object, key: PropertyKey, found: PropertyDescriptor) {
  if (mockedSlots === undefined) return;
  const origin: PropertyDescriptor | undefined = WeakMapPrototypeGet.$call(origins, found);
  let objects = mockedSlots.$get(key);
  if (origin === undefined) {
    objects?.$delete(object);
    return;
  }
  // `found` is an earlier mock, and the slot holds it again.
  if (objects === undefined) mockedSlots.$set(key, (objects = new Map()));
  objects.$set(object, origin);
}

/** Gives every slot that still holds a mock the descriptor it had before its first mock. */
function restoreMockedSlots() {
  const slots = mockedSlots;
  if (slots === undefined || slots.$size === 0) return;
  // A setter or a proxy that a restore runs can mock again. That mock belongs to the next file.
  mockedSlots = new Map();
  slots.$forEach((objects, key) => {
    objects.$forEach((origin, object) => {
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
