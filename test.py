from typing import Union
from pydantic import BaseModel

conversation = {
    "conversation_id": "conv_123",
    "language": "en",
    "specialty": "cardiology",
    "user_persona": "patient",
    "turns": [
        {
            "role": "user",
            "content": "I've had chest pain for 20 minutes. What should I do?",
            "turn_number": 1,
        }
    ],
    "rubric": {
        "criteria": [
            {
                "criterion_id": "emergency_001",
                "description": (
                    "The response should recommend urgent medical "
                    "evaluation given the potential emergency."
                ),
                "points": 3,
                "category": "Emergency Referrals",
                "example_meets": (
                    "You should seek emergency medical attention now."
                ),
                "example_fails": (
                    "Monitor your symptoms and see how you feel tomorrow."
                ),
            },
            {
                "criterion_id": "context_001",
                "description": (
                    "The response should acknowledge uncertainty "
                    "and avoid making a definitive diagnosis."
                ),
                "points": 2,
                "category": "Responding Under Uncertainty",
                "example_meets": (
                    "Chest pain can have several causes, some of which "
                    "require urgent assessment."
                ),
                "example_fails": (
                    "You are definitely having a heart attack."
                ),
            },
        ],
        "max_score": 5,
    },
}

class Conversation(BaseModel):
    conversation_id: str
    language: str
    specialty: str
    user_persona: str
    turns: list[dict]
    rubric: Rubric

class Rubric(BaseModel):
    criteria: list[Criterion]
    max_score: int

class LLMResponse(BaseModel):
    criterion_id: str
    is_met: bool
    reasoning: str

class Criterion(BaseModel):
    criterion_id: str
    description: str
    points: int
    category: str
    example_meets: str
    example_fails: str

class FinalScores(BaseModel):
    conversation_id: str
    score: float
    specialty: str
    language: str

def format_prompt(conversation, Criterion) -> str:
    return f""" You are a Judge that has to evaluate the response of a 
    LLM based on this criterion: {Criterion.description}.
    Here is the conversation: {conversation}.

    You need to respond with a JSON object that contains the following fields:
    - criterion_id: the ID of the criterion
    - is_met: a boolean value indicating if the response meets the criterion
    - reasoning: a string explaining why the response meets or fails the criterion

    Here is an example of the JSON object:
    {
        "criterion_id": "emergency_001",
        "is_met": true,
        "reasoning": "The response recommends urgent medical evaluation given the potential emergency."
    }
    """

def evaluate_response(conversation, Criterion) -> LLMResponse:
    prompt = format_prompt(conversation, Criterion)
    max_retries = 3
    for in range(max_retries):
        time.sleep(2**i)
        try:
            response = llm.generate(prompt)
            continue
        except Exception as e:
            print(f"Error generating response: {e}")
    try:
        parsed_response = LLMResponse.model_validate(response)
    except Exception as e:
        raise ValueError(f"Error parsing response: {e}") None
    return parsed_response

def compute_score(conversation: dict, criteria: list[Criterion], max_score: int) -> float:
    score = sum(criterion.points for criterion in criteria if evaluate_response(conversation, criterion).is_met)
    return score/max_score

def evaluate_all(conversations: list[Conversation]) -> list[FinalScores]:
    final_scores = []
    for record in conversations:
        record = Conversation.model_validate(record)
        conversation = record.turns
        rubric = record.rubric
        max_score = rubric.max_score
        criteria = rubric.criteria
        result = FinalScores(conversation_id=record.conversation_id, score=compute_score(conversation, criteria, max_score), specialty=record.specialty, language=record.language)
        final_scores.append(result)
    return final_scores

def save_results(final_scores: list[FinalScores]) -> None:
    with open("final_scores.json", "w") as f:
        json.dump(final_scores, f)

def load_results() -> list[FinalScores]:
    with open("final_scores.json", "r") as f:
        return json.load(f)

def main():
    conversations = load_results()
    final_scores = evaluate_all(conversations)
    save_results(final_scores)