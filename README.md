# ksot
Koster Object Table

## Example
Plain ksot without features
```ksot
{
    "name": "test",
    "color": "0xFFFFD700",
    "number: 10,
    "object": {
        "array": ["apple", "peach"]
    }
}
```

Ksot with features
```ksot
@ksot

@com ==================
@com This is a Command!
@com ==================

{
    "name": String: "test",
    "color": Color: 0xFFFFD700,
    "number: Int: 10,
    "object": Object: {
        "array": Array: ["apple", "peach"]
    }
}
```
