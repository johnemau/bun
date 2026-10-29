// The properties that hold a `node:test` mock, for the boundary between two
// test files of one `bun test` run. A slot is one property: an object and a key.
//
// node runs each test file in a process of its own, so a mock that a file
// leaves installed ends with that process. `bun test` runs its files in one
// realm, and node:test undoes those mocks at the boundary. Replaying
// MockTracker.reset() cannot do that alone. As in node, each mock writes back
// the descriptor it found, first mock first, so a slot that was mocked twice
// ends up holding its first mock:
// https://github.com/nodejs/node/blob/50c35fea9e64d50ab3bb5f359e8523de89d6c798/lib/internal/test_runner/mock/mock.js#L746-L752
// So the slots that hold a mock are listed here with what each held before
// its first mock. A slot that cannot take that back keeps its mock.

// Captured at load: a test file can mock any of these.
const MapConstructor = Map;
const WeakMapConstructor = WeakMap;
const WeakMapPrototypeGet = WeakMap.prototype.get;
const WeakMapPrototypeSet = WeakMap.prototype.set;
const WeakRefConstructor = WeakRef;
const WeakRefPrototypeDeref = WeakRef.prototype.deref;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ReflectDeleteProperty = Reflect.deleteProperty;

/** What a slot held before its first mock. null: the object had no property of its own there. */
type Origin = PropertyDescriptor | null;

// The slots whose mock is installed. undefined where nothing calls restoreMockedSlots(): outside
// `bun test`, and in a Worker. The key comes first: a file mocks few property names, on any
// number of objects, and the map of a name is made once for a file.
let mockedSlots: Map<PropertyKey, Map<object, Origin>> | undefined;
// Every function that a mock put in a slot → the origin of that slot.
const mockFunctions = new WeakMapConstructor<Function, Origin>();
// The slots that hold an earlier mock again, because the restore of a later one put it back.
// Often nothing else holds their objects by then, so this does not either.
let slotsWithEarlierMock: { object: WeakRef<object>; key: PropertyKey; origin: Origin }[] = [];
// While node:test undoes what a file left, a restore writes only where a mock still is.
let atFileBoundary = false;

function trackMockedSlots() {
  mockedSlots ??= new MapConstructor();
}

/** The origin of the slot that `descriptor` is a mock of. undefined: it holds no mock. */
function originOfMock(descriptor: PropertyDescriptor | undefined): Origin | undefined {
  if (descriptor === undefined) return undefined;
  const { value, get, set } = descriptor;
  let origin: Origin | undefined;
  if ($isCallable(value)) origin = WeakMapPrototypeGet.$call(mockFunctions, value);
  if (origin === undefined && $isCallable(get)) origin = WeakMapPrototypeGet.$call(mockFunctions, get);
  if (origin === undefined && $isCallable(set)) origin = WeakMapPrototypeGet.$call(mockFunctions, set);
  return origin;
}

/**
 * A mock replaced `object[key]` by `mock`, and by `otherMock` too if it made both accessors.
 * `found` is the property of its own that `object` had there, if any.
 */
function slotMocked(
  object: object,
  key: PropertyKey,
  found: PropertyDescriptor | undefined,
  mock: Function,
  otherMock?: Function,
) {
  if (mockedSlots === undefined) return;
  let objects = mockedSlots.$get(key);
  if (objects === undefined) mockedSlots.$set(key, (objects = new MapConstructor()));
  let origin = objects.$get(object);
  if (origin === undefined) {
    // An unlisted slot can hold a mock: one that a restore put back, or one made through a proxy of `object`.
    origin = originOfMock(found);
    if (origin === undefined) origin = found ?? null;
    objects.$set(object, origin);
  }
  WeakMapPrototypeSet.$call(mockFunctions, mock, origin);
  if (otherMock !== undefined) WeakMapPrototypeSet.$call(mockFunctions, otherMock, origin);
}

/** Lists the slot that mock timers gave a fake. `found` is what `object[key]` held. */
function slotFaked(object: object, key: PropertyKey, found: PropertyDescriptor | undefined) {
  if (mockedSlots === undefined) return;
  const fake = ObjectGetOwnPropertyDescriptor(object, key)?.value;
  if ($isCallable(fake)) slotMocked(object, key, found, fake);
}

/** True when a restore must leave `object[key]` alone: the file is over and something else replaced the mock. */
function restoreSkipped(object: object, key: PropertyKey) {
  return atFileBoundary && originOfMock(ObjectGetOwnPropertyDescriptor(object, key)) === undefined;
}

/**
 * A mock put `found`, the descriptor it had found, back in `object[key]`. With `copy`, it put that
 * function there in place of the one in `found`, as the reset of `scheduler.wait` does.
 */
function slotRestored(object: object, key: PropertyKey, found: PropertyDescriptor | undefined, copy?: Function) {
  if (mockedSlots === undefined) return;
  let objects = mockedSlots.$get(key);
  const listed = objects?.$get(object);
  const earlier = originOfMock(found);
  if (copy !== undefined) {
    // Not what the slot held: it stays listed, and the boundary writes the origin.
    const origin = listed !== undefined ? listed : earlier !== undefined ? earlier : (found ?? null);
    if (objects === undefined) mockedSlots.$set(key, (objects = new MapConstructor()));
    objects.$set(object, origin);
    WeakMapPrototypeSet.$call(mockFunctions, copy, origin);
    return;
  }
  objects?.$delete(object);
  if (earlier !== undefined) {
    $arrayPush(slotsWithEarlierMock, {
      object: new WeakRefConstructor(object),
      key,
      origin: listed !== undefined ? listed : earlier,
    });
  }
}

/** Writes back what mock timers found in `object[key]`. */
function putDescriptor(object: object, key: PropertyKey, found: PropertyDescriptor) {
  if (restoreSkipped(object, key)) return;
  ObjectDefineProperty(object, key, found);
  slotRestored(object, key, found);
}

function restoreSlot(object: object, key: PropertyKey, origin: Origin) {
  try {
    // What the file or bun:test wrote over the mock since then stays.
    if (originOfMock(ObjectGetOwnPropertyDescriptor(object, key)) === undefined) return;
    if (origin === null) ReflectDeleteProperty(object, key);
    else ObjectDefineProperty(object, key, origin);
  } catch {
    // The slot refuses: its property is not configurable, or a proxy throws. In node the process
    // ends here and nothing fails. A function mock in such a slot calls the original from now
    // on (resetTrackerAtFileBoundary() in node:test), and the slot keeps it.
  }
}

function startFileBoundary() {
  atFileBoundary = true;
}

/** Gives each slot that still holds a mock what it held before its first mock, and ends the boundary. */
function restoreMockedSlots() {
  atFileBoundary = false;
  const slots = mockedSlots;
  const withEarlierMock = slotsWithEarlierMock;
  if (slots === undefined || (slots.$size === 0 && withEarlierMock.length === 0)) return;
  // A setter or a proxy that a restore runs can mock again. That mock belongs to the next file.
  mockedSlots = new MapConstructor();
  slotsWithEarlierMock = [];
  slots.$forEach((objects, key) => {
    objects.$forEach((origin, object) => restoreSlot(object, key, origin));
  });
  for (let i = 0; i < withEarlierMock.length; i++) {
    const { key, origin } = withEarlierMock[i];
    const object = WeakRefPrototypeDeref.$call(withEarlierMock[i].object);
    if (object !== undefined) restoreSlot(object, key, origin);
  }
}

export default {
  trackMockedSlots,
  slotMocked,
  slotFaked,
  slotRestored,
  restoreSkipped,
  putDescriptor,
  startFileBoundary,
  restoreMockedSlots,
};
