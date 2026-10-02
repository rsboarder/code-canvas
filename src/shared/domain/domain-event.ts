export interface DomainEvent<Type extends string = string> {
  readonly type: Type;
}
