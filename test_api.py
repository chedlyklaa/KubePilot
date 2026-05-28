import os
from openai import OpenAI


def main():
    client = OpenAI(
        api_key="f8c180d8-e6e0-4863-a1b1-c6baef2bef70",
        base_url="https://api.scaleway.ai/415f75df-ce97-4134-bd3f-6d9624cf1186/v1",
    )
    print("Testing connection to OpenAI API...")
    try:
        print("Using model:", "qwen3.5-397b-a17b")
        response = client.chat.completions.create(
            model="qwen3.5-397b-a17b",
            messages=[
                {"role": "user", "content": "who are you?"}
            ],
            temperature=0,
        )
        print("Raw response:", response)
        print(response.choices[0].message.content)

    except Exception as e:
        print("Error:", type(e).__name__, e)


if __name__ == "__main__":
    main()