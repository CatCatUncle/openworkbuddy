/-!
Formal specification for the shared-provider model setup.

This proves the routing invariants for the small configuration transition below.
The JavaScript implementation and DOM behavior remain covered by `npm test`;
this file is not a proof of the whole application.
-/

inductive Capability where
  | chat
  | image
  | video
  | tts
  | asr
  deriving DecidableEq, Repr

structure Provider where
  id : Nat
  endpoint : String
  apiKey : String
  capabilities : List Capability
  deriving DecidableEq, Repr

structure ModelRef where
  providerId : Nat
  capability : Capability
  modelId : String
  deriving DecidableEq, Repr

structure Config where
  providers : List Provider
  models : List ModelRef
  deriving DecidableEq, Repr

def addModel (config : Config) (provider : Provider)
    (capability : Capability) (modelId : String) : Option Config :=
  if provider ∈ config.providers ∧ capability ∈ provider.capabilities then
    some { config with
      models := { providerId := provider.id, capability, modelId } :: config.models }
  else
    none

theorem acceptedModel_keepsChannelSettings
    (config : Config) (provider : Provider) (capability : Capability) (modelId : String)
    (next : Config)
    (accepted : addModel config provider capability modelId = some next) :
    next.providers = config.providers := by
  unfold addModel at accepted
  split at accepted
  · cases accepted
    rfl
  · contradiction

theorem acceptedModel_reusesProviderAndCapability
    (config : Config) (provider : Provider) (capability : Capability) (modelId : String)
    (next : Config)
    (accepted : addModel config provider capability modelId = some next) :
    ∃ route, route ∈ next.models ∧ route.providerId = provider.id ∧
      route.capability = capability ∧ route.modelId = modelId ∧
      provider ∈ next.providers ∧ capability ∈ provider.capabilities := by
  unfold addModel at accepted
  split at accepted
  · rename_i allowed
    cases accepted
    refine ⟨{ providerId := provider.id, capability, modelId }, ?_, rfl, rfl, rfl, ?_, allowed.2⟩
    · simp
    · simpa using allowed.1
  · contradiction

theorem unsupportedCapability_isRejected
    (config : Config) (provider : Provider) (capability : Capability) (modelId : String)
    (unsupported : capability ∉ provider.capabilities) :
    addModel config provider capability modelId = none := by
  unfold addModel
  split
  · rename_i allowed
    exact False.elim (unsupported allowed.2)
  · rfl
