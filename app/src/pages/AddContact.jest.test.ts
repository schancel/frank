/**
 * Component-logic tests load AddContact.vue's TypeScript block directly. The repository's
 * checked-in Babel config names an undeclared legacy Vue-transform plugin, so importing an SFC
 * under Jest fails before component code runs. Exercising the exported options object keeps this
 * regression at the real watcher/method boundary without changing dependency scope.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

import enUs from '../i18n/en-us'
import frFr from '../i18n/fr-fr'

type ChainAddress = { raw: string }
type ProfileInfo = {
  address: ChainAddress
  name?: string
  bio?: string
  avatar?: string
  pubKey: Uint8Array
}
type Contact = { profile?: { name?: string } }
type AcceptedLookup = { resolvedAddress: string; contact: Contact }
type Page = {
  address: string
  acceptedLookup: AcceptedLookup | null
  canAdd: boolean
  addContact(): void
  [key: string]: unknown
}
type ComponentOptions = {
  data(): Record<string, unknown>
  setup(): Record<string, unknown>
  computed: Record<string, (this: Page) => unknown>
  watch: { address(this: Page, address: string): Promise<void> }
  methods: Record<string, (this: Page, ...args: never[]) => unknown>
}
type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

const ADDRESS_A = 'canonical:a'
const ADDRESS_B = 'canonical:b'
const ADDRESS_C = 'canonical:c'
const parsedAddresses: Record<string, ChainAddress> = {
  a: { raw: ADDRESS_A },
  A: { raw: ADDRESS_A },
  b: { raw: ADDRESS_B },
  c: { raw: ADDRESS_C },
}

const mockAddContactToStore = jest.fn()
const mockOpenChat = jest.fn()
const mockRouter = { go: jest.fn(), push: jest.fn() }
const activeChain = {
  name: 'Test chain',
  parseAddress: jest.fn<ChainAddress | undefined, [string]>(),
  formatAddress: jest.fn<string, [ChainAddress]>(),
  fetchProfile: jest.fn<Promise<ProfileInfo | undefined>, [ChainAddress]>(),
}

const componentSource = fs.readFileSync(
  path.join(__dirname, 'AddContact.vue'),
  'utf8',
)

function loadComponent(): ComponentOptions {
  const script = componentSource.match(
    /<script lang="ts">([\s\S]*?)<\/script>/,
  )?.[1]
  if (!script) {
    throw new Error('AddContact.vue TypeScript block not found')
  }
  const withoutImports = script.replace(
    /import[\s\S]*?from\s+['"][^'"]+['"]\s*/g,
    '',
  )
  const javascript = ts.transpileModule(withoutImports, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText
  const evaluate = new Function(
    'exports',
    'defineComponent',
    'markRaw',
    'ref',
    'activeChain',
    'PublicKey',
    'defaultRelayData',
    'useContactStore',
    'openChat',
    `${javascript}; return exports.default`,
  ) as (...args: unknown[]) => ComponentOptions

  return evaluate(
    {},
    (options: ComponentOptions) => options,
    (value: unknown) => value,
    (value: unknown) => ({ value }),
    activeChain,
    { fromBuffer: jest.fn(() => ({ kind: 'public-key' })) },
    { profile: { name: '', bio: '', avatar: '' } },
    () => ({ addContact: mockAddContactToStore }),
    mockOpenChat,
  )
}

const component = loadComponent()

function createPage(): Page {
  const page = Object.assign(
    component.data(),
    component.setup(),
    component.methods,
    { $router: mockRouter },
  ) as unknown as Page
  for (const [name, getter] of Object.entries(component.computed)) {
    Object.defineProperty(page, name, { get: () => getter.call(page) })
  }
  return page
}

function startAddress(page: Page, address: string): Promise<void> {
  page.address = address
  return component.watch.address.call(page, address)
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function profile(address: string, name: string): ProfileInfo {
  return {
    address: { raw: address },
    name,
    pubKey: Uint8Array.from([2]),
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AddContact latest lookup', () => {
  beforeEach(() => {
    mockAddContactToStore.mockReset()
    mockOpenChat.mockReset()
    mockRouter.go.mockReset()
    mockRouter.push.mockReset()
    activeChain.parseAddress.mockReset()
    activeChain.formatAddress.mockReset()
    activeChain.fetchProfile.mockReset()
    activeChain.parseAddress.mockImplementation(input => parsedAddresses[input])
    activeChain.formatAddress.mockImplementation(address => address.raw)
  })

  it('canonicalizes the lookup, performs one fetch, and commits the exact accepted pair', async () => {
    activeChain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))
    const page = createPage()

    await startAddress(page, '  a  ')

    expect(activeChain.parseAddress).toHaveBeenCalledWith('a')
    expect(activeChain.fetchProfile).toHaveBeenCalledTimes(1)
    expect(activeChain.fetchProfile).toHaveBeenCalledWith(parsedAddresses.a)
    expect(page.acceptedLookup?.resolvedAddress).toBe(ADDRESS_A)
    expect(page.acceptedLookup?.contact.profile?.name).toBe('Alice')
    expect(page.canAdd).toBe(true)

    const acceptedContact = page.acceptedLookup?.contact
    page.addContact()

    expect(mockAddContactToStore).toHaveBeenCalledTimes(1)
    expect(mockAddContactToStore).toHaveBeenCalledWith({
      address: ADDRESS_A,
      contact: acceptedContact,
    })
    expect(mockOpenChat).toHaveBeenCalledTimes(1)
    expect(mockOpenChat).toHaveBeenCalledWith(mockRouter, ADDRESS_A)
  })

  it('keeps B when B resolves before an older A lookup', async () => {
    const lookupA = deferred<ProfileInfo | undefined>()
    const lookupB = deferred<ProfileInfo | undefined>()
    activeChain.fetchProfile
      .mockImplementationOnce(() => lookupA.promise)
      .mockImplementationOnce(() => lookupB.promise)
    const page = createPage()

    void startAddress(page, 'a')
    void startAddress(page, 'b')
    lookupB.resolve(profile(ADDRESS_B, 'Bob'))
    await settle()
    expect(page.acceptedLookup?.resolvedAddress).toBe(ADDRESS_B)

    lookupA.resolve(profile(ADDRESS_A, 'Alice'))
    await settle()
    expect(page.acceptedLookup?.resolvedAddress).toBe(ADDRESS_B)
    expect(page.acceptedLookup?.contact.profile?.name).toBe('Bob')

    const acceptedContact = page.acceptedLookup?.contact
    page.addContact()
    expect(mockAddContactToStore).toHaveBeenCalledWith({
      address: ADDRESS_B,
      contact: acceptedContact,
    })
    expect(mockOpenChat).toHaveBeenCalledWith(mockRouter, ADDRESS_B)
  })

  it('ignores stale rejection and stale not-found completions', async () => {
    const staleRejection = deferred<ProfileInfo | undefined>()
    const currentB = deferred<ProfileInfo | undefined>()
    const staleNotFound = deferred<ProfileInfo | undefined>()
    const currentA = deferred<ProfileInfo | undefined>()
    activeChain.fetchProfile
      .mockImplementationOnce(() => staleRejection.promise)
      .mockImplementationOnce(() => currentB.promise)
      .mockImplementationOnce(() => staleNotFound.promise)
      .mockImplementationOnce(() => currentA.promise)
    const page = createPage()

    void startAddress(page, 'a')
    void startAddress(page, 'b')
    currentB.resolve(profile(ADDRESS_B, 'Bob'))
    await settle()
    staleRejection.reject(new Error('old lookup failed'))
    await settle()
    expect(page.acceptedLookup?.resolvedAddress).toBe(ADDRESS_B)

    void startAddress(page, 'c')
    void startAddress(page, 'a')
    currentA.resolve(profile(ADDRESS_A, 'Alice'))
    await settle()
    staleNotFound.resolve(undefined)
    await settle()
    expect(page.acceptedLookup?.resolvedAddress).toBe(ADDRESS_A)
  })

  it('ignores A settling while B is pending and refuses Add', async () => {
    const lookupA = deferred<ProfileInfo | undefined>()
    const lookupB = deferred<ProfileInfo | undefined>()
    activeChain.fetchProfile
      .mockImplementationOnce(() => lookupA.promise)
      .mockImplementationOnce(() => lookupB.promise)
    const page = createPage()

    void startAddress(page, 'a')
    void startAddress(page, 'b')
    lookupA.resolve(profile(ADDRESS_A, 'Alice'))
    await settle()
    expect(page.acceptedLookup).toBeNull()
    expect(page.canAdd).toBe(false)
    page.addContact()
    expect(mockAddContactToStore).not.toHaveBeenCalled()
    expect(mockOpenChat).not.toHaveBeenCalled()
  })

  it('invalidates an accepted lookup when the input is cleared or changed', async () => {
    activeChain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))
    const page = createPage()

    await startAddress(page, 'a')
    expect(page.acceptedLookup).not.toBeNull()
    await startAddress(page, '')
    expect(page.acceptedLookup).toBeNull()

    await startAddress(page, 'a')
    expect(page.acceptedLookup).not.toBeNull()
    await startAddress(page, 'not-an-address')
    expect(page.acceptedLookup).toBeNull()
    expect(page.canAdd).toBe(false)
  })

  it('rejects a profile whose returned address does not match the requested address', async () => {
    activeChain.fetchProfile.mockResolvedValue(profile(ADDRESS_B, 'Impostor'))
    const page = createPage()

    await startAddress(page, 'a')

    expect(page.acceptedLookup).toBeNull()
    expect(page.canAdd).toBe(false)
    page.addContact()
    expect(mockAddContactToStore).not.toHaveBeenCalled()
    expect(mockOpenChat).not.toHaveBeenCalled()
  })

  it('freshly normalizes canonical-equivalent input for enablement and execution', async () => {
    activeChain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))
    const page = createPage()
    await startAddress(page, 'a')
    const acceptedContact = page.acceptedLookup?.contact
    activeChain.parseAddress.mockClear()
    activeChain.formatAddress.mockClear()

    page.address = '  A  '
    expect(page.canAdd).toBe(true)
    expect(activeChain.parseAddress).toHaveBeenCalledWith('A')
    expect(activeChain.formatAddress).toHaveBeenCalledWith(parsedAddresses.A)

    page.addContact()
    expect(activeChain.parseAddress).toHaveBeenCalledTimes(2)
    expect(activeChain.formatAddress).toHaveBeenCalledTimes(2)
    expect(mockAddContactToStore).toHaveBeenCalledWith({
      address: ADDRESS_A,
      contact: acceptedContact,
    })
    expect(mockOpenChat).toHaveBeenCalledWith(mockRouter, ADDRESS_A)
  })

  it('safely disables and refuses Add when fresh normalization throws', async () => {
    activeChain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))
    const page = createPage()
    await startAddress(page, 'a')
    page.address = 'broken'
    activeChain.parseAddress.mockImplementation(() => {
      throw new Error('invalid address')
    })

    expect(() => page.canAdd).not.toThrow()
    expect(page.canAdd).toBe(false)
    expect(() => page.addContact()).not.toThrow()
    expect(mockAddContactToStore).not.toHaveBeenCalled()
    expect(mockOpenChat).not.toHaveBeenCalled()
  })

  it('provides a persistent localized status region and bounded decorative skeletons', () => {
    const template = componentSource.match(
      /<template>([\s\S]*?)<\/template>/,
    )?.[1]
    expect(template).toBeDefined()
    const statusRegion = template?.match(
      /<div[^>]*class="q-sr-only"[^>]*role="status"[^>]*aria-live="polite"[^>]*>/,
    )?.[0]
    expect(statusRegion).toBeDefined()
    expect(statusRegion).not.toContain('v-if')
    expect(template).toContain(':aria-busy="loading"')
    expect(template).toContain("$t('newContactDialog.loading')")
    expect(template).toContain("$t('newContactDialog.notFound')")
    expect(template).toContain("$t('newContactDialog.found'")
    expect(enUs.newContactDialog.loading).toBeTruthy()
    expect(enUs.newContactDialog.found).toContain('{name}')
    expect(frFr.newContactDialog.loading).toBeTruthy()
    expect(frFr.newContactDialog.found).toContain('{name}')

    const skeletons = template?.match(/<q-skeleton\b[^>]*\/>/g) ?? []
    expect(skeletons).toHaveLength(3)
    for (const skeleton of skeletons) {
      expect(skeleton).toContain('aria-hidden="true"')
      expect(skeleton).toContain('animation="none"')
    }
  })
})
